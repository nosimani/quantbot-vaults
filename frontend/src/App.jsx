import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, formatUnits, parseUnits, MaxUint256 } from "ethers";
import { CONFIG, isConfigured } from "./config.js";
import { VAULT_ABI, ERC20_ABI, STRATEGY_ABI } from "./abi.js";

const DEC = 6; // mUSDC
const SHARE_DEC = 9; // 6 decimales del activo + offset 3 del vault
const fmt = (v, d = DEC) => Number(formatUnits(v ?? 0n, d)).toLocaleString("es-AR", { maximumFractionDigits: 4 });
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Convierte segundos en un texto corto (1h 5m 3s). */
function eta(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s === 0) return "0 s";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return [h ? `${h} h` : "", m ? `${m} m` : "", r ? `${r} s` : ""].filter(Boolean).join(" ");
}

export default function App() {
  const [account, setAccount] = useState(null);
  const [signer, setSigner] = useState(null);
  const [chainOk, setChainOk] = useState(true);
  const [data, setData] = useState(null);
  const [amount, setAmount] = useState("100");
  const [allocAmount, setAllocAmount] = useState("50");
  const [pnl, setPnl] = useState("10");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const addLog = (msg, hash) => setLog((l) => [{ msg, hash, t: new Date().toLocaleTimeString() }, ...l].slice(0, 12));

  // Contratos de SOLO LECTURA (no requieren wallet): permiten ver el estado del vault y probar la app sin conectar.
  const reads = useMemo(() => {
    if (!isConfigured()) return null;
    const provider = new JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true });
    return {
      vault: new Contract(CONFIG.vault, VAULT_ABI, provider),
      token: new Contract(CONFIG.asset, ERC20_ABI, provider),
      strategy: new Contract(CONFIG.strategy, STRATEGY_ABI, provider),
    };
  }, []);

  // Contratos con firmante (escritura), solo si hay wallet conectada.
  const writes = useMemo(() => {
    if (!signer || !isConfigured()) return null;
    return {
      vault: new Contract(CONFIG.vault, VAULT_ABI, signer),
      token: new Contract(CONFIG.asset, ERC20_ABI, signer),
      strategy: new Contract(CONFIG.strategy, STRATEGY_ABI, signer),
    };
  }, [signer]);

  const connect = async () => {
    if (!window.ethereum) return alert("Instalá MetaMask u otra wallet EVM para operar. Igual podés ver el estado del vault sin wallet.");
    await window.ethereum.request({ method: "eth_requestAccounts" });
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + CONFIG.chainId.toString(16) }],
      });
    } catch (e) {
      console.warn("No se cambió de red", e);
    }
    const provider = new BrowserProvider(window.ethereum);
    const net = await provider.getNetwork();
    setChainOk(Number(net.chainId) === CONFIG.chainId);
    const s = await provider.getSigner();
    setSigner(s);
    setAccount(await s.getAddress());
  };

  const refresh = useCallback(async () => {
    if (!reads) return;
    const { vault, token, strategy } = reads;
    const [total, idle, supply, paused, fee, stratAssets, info, locked, period, lastReport, pending, sharePrice] = await Promise.all([
      vault.totalAssets(),
      vault.idleAssets(),
      vault.totalSupply(),
      vault.paused(),
      vault.performanceFeeBps(),
      strategy.totalAssets(),
      vault.strategyInfo(CONFIG.strategy),
      vault.lockedProfitRemaining(),
      vault.profitUnlockPeriod(),
      vault.lastProfitReport(),
      vault.pendingFee(),
      vault.convertToAssets(10n ** BigInt(SHARE_DEC)),
    ]);

    let user = { myShares: 0n, myAssets: 0n, maxRedeem: 0n, balance: 0n, allowance: 0n, isOperator: false, isGuardian: false, isBot: false };
    if (account) {
      const [myShares, balance, allowance, maxRedeem, opRole, grdRole, botRole] = await Promise.all([
        vault.balanceOf(account),
        token.balanceOf(account),
        token.allowance(account, CONFIG.vault),
        vault.maxRedeem(account),
        vault.OPERATOR_ROLE(),
        vault.GUARDIAN_ROLE(),
        strategy.BOT_ROLE(),
      ]);
      const myAssets = await vault.previewRedeem(myShares);
      const [isOperator, isGuardian, isBot] = await Promise.all([
        vault.hasRole(opRole, account),
        vault.hasRole(grdRole, account),
        strategy.hasRole(botRole, account),
      ]);
      user = { myShares, myAssets, maxRedeem, balance, allowance, isOperator, isGuardian, isBot };
    }

    setData({
      total, idle, supply, paused, fee, stratAssets, info, locked, period, lastReport,
      pendingFee: pending[0], sharePrice, ...user,
    });
  }, [reads, account]);

  useEffect(() => {
    refresh().catch((e) => addLog(`Error al leer datos: ${e.shortMessage || e.message}`));
    const id = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
      refresh().catch(() => {});
    }, 12000);
    return () => clearInterval(id);
  }, [refresh]);

  const run = async (label, fn) => {
    setBusy(true);
    try {
      const tx = await fn();
      addLog(`${label}: enviada…`, tx.hash);
      await tx.wait();
      addLog(`${label}: confirmada ✔`, tx.hash);
      await refresh();
    } catch (e) {
      addLog(`${label}: ${e.reason || e.shortMessage || e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const units = (v) => parseUnits(v || "0", DEC);

  if (!isConfigured()) {
    return (
      <main className="wrap">
        <h1>QuantBot Vaults</h1>
        <p className="card warn">
          Falta configurar las direcciones. Copiá <code>frontend/.env.example</code> a <code>frontend/.env</code> y completá
          <code> VITE_VAULT_ADDRESS</code>, <code>VITE_ASSET_ADDRESS</code> y <code>VITE_STRATEGY_ADDRESS</code>.
        </p>
      </main>
    );
  }

  const canWrite = Boolean(writes) && chainOk;
  const needsApproval = data && units(amount) > data.allowance;
  const price = data ? Number(formatUnits(data.sharePrice, DEC)).toFixed(6) : "1.000000";
  const unreported = data && data.stratAssets > BigInt(data.info.debt) ? data.stratAssets - BigInt(data.info.debt) : 0n;
  const unlockEnd = data ? Number(data.lastReport) + Number(data.period) : 0;

  return (
    <main className="wrap">
      <header>
        <div>
          <h1>QuantBot Vaults</h1>
          <p className="sub">Bóvedas ERC-4626 para estrategias de trading algorítmico on-chain</p>
        </div>
        {account ? <span className="pill">{short(account)}</span> : <button onClick={connect}>Conectar wallet</button>}
      </header>

      {!account && (
        <p className="card hint">
          Modo lectura: estás viendo el estado real del vault en Sepolia sin wallet. Conectá MetaMask para depositar, retirar u operar.
        </p>
      )}
      {account && !chainOk && <p className="card warn">Cambiá la red de tu wallet a chainId {CONFIG.chainId} (Sepolia).</p>}

      {!data && <p className="card hint">Leyendo el estado del vault…</p>}

      {data && (
        <>
          <section className="grid">
            <Stat label="TVL (totalAssets)" value={`${fmt(data.total)} mUSDC`} />
            <Stat label="Liquidez en vault" value={`${fmt(data.idle)} mUSDC`} />
            <Stat label="En estrategia (bot)" value={`${fmt(data.stratAssets)} mUSDC`} />
            <Stat label="Precio por share" value={`${price} mUSDC`} />
            <Stat label="Ganancia bloqueada" value={`${fmt(data.locked)} mUSDC`} />
            <Stat label="Comisión pendiente" value={`${fmt(data.pendingFee)} mUSDC`} />
            <Stat label="Fee de performance" value={`${Number(data.fee) / 100} %`} />
            <Stat label="Estado" value={data.paused ? "⏸ Pausado" : "● Activo"} />
          </section>

          <section className="card">
            <h2>Protección contra depósitos/retiros oportunistas</h2>
            <p className="hint">
              Las ganancias del bot no entran de golpe al valor del vault: se bloquean y se liberan de forma lineal durante{" "}
              <b>{eta(Number(data.period))}</b>. Quien deposita justo antes de una ganancia y retira justo después no se
              lleva el rendimiento de los demás. Las pérdidas, en cambio, se reflejan de inmediato.
            </p>
            {data.locked > 0n ? (
              <p>
                Ganancia bloqueada: <b>{fmt(data.locked)} mUSDC</b> · se libera por completo en{" "}
                <b>{eta(unlockEnd - now)}</b>.
              </p>
            ) : (
              <p className="hint">No hay ganancia bloqueada en este momento.</p>
            )}
            {unreported > 0n && (
              <p className="hint">Hay {fmt(unreported)} mUSDC de ganancia en la estrategia sin reportar: se reconocerá con «Reportar y cobrar fee».</p>
            )}
          </section>

          <section className="card">
            <h2>Mi posición</h2>
            {account ? (
              <p>
                Saldo mUSDC: <b>{fmt(data.balance)}</b> · Shares: <b>{fmt(data.myShares, SHARE_DEC)}</b> · Valor:{" "}
                <b>{fmt(data.myAssets)} mUSDC</b>
              </p>
            ) : (
              <p className="hint">Conectá tu wallet para ver tu posición.</p>
            )}
            <div className="row">
              <button disabled={busy || !canWrite} onClick={() => run("Faucet", () => writes.token.faucet())}>
                Pedir 10.000 mUSDC (faucet)
              </button>
            </div>
            <div className="row">
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              {needsApproval ? (
                <button disabled={busy || !canWrite} onClick={() => run("Approve", () => writes.token.approve(CONFIG.vault, MaxUint256))}>
                  1. Aprobar
                </button>
              ) : (
                <button disabled={busy || !canWrite || data.paused} onClick={() => run("Depósito", () => writes.vault.deposit(units(amount), account))}>
                  Depositar
                </button>
              )}
              <button
                className="ghost"
                disabled={busy || !canWrite || data.maxRedeem === 0n}
                onClick={() => run("Retiro", () => writes.vault.redeem(data.maxRedeem, account, account))}
              >
                Retirar máximo disponible
              </button>
            </div>
            <p className="hint">
              El retiro está limitado por la liquidez del vault ({fmt(data.idle)} mUSDC). Incluso en pausa se puede retirar. El valor
              mostrado ya descuenta la comisión pendiente.
            </p>
          </section>

          <section className="card">
            <h2>Estrategia (bot)</h2>
            <p>
              Valor reconocido (deuda): <b>{fmt(data.info.debt)}</b> mUSDC · Tope: <b>{Number(data.info.maxAllocationBps) / 100} %</b> ·{" "}
              {data.info.active ? "activa" : "desactivada por circuit breaker/guardián"}
            </p>
            <div className="row">
              <input value={allocAmount} onChange={(e) => setAllocAmount(e.target.value)} inputMode="decimal" />
              <button disabled={busy || !canWrite || !data.isOperator} onClick={() => run("Allocate", () => writes.vault.allocate(CONFIG.strategy, units(allocAmount)))}>
                Asignar al bot
              </button>
              <button
                className="ghost"
                disabled={busy || !canWrite || !data.isOperator}
                onClick={() => run("Recall", () => writes.vault.recall(CONFIG.strategy, data.stratAssets))}
              >
                Recuperar todo
              </button>
            </div>
            <div className="row">
              <input value={pnl} onChange={(e) => setPnl(e.target.value)} inputMode="decimal" />
              <button
                disabled={busy || !canWrite || !data.isBot}
                onClick={() =>
                  run("Ganancia del bot", async () => {
                    const allowance = await writes.token.allowance(account, CONFIG.strategy);
                    if (allowance < units(pnl)) await (await writes.token.approve(CONFIG.strategy, MaxUint256)).wait();
                    return writes.strategy.executeTrade(units(pnl));
                  })
                }
              >
                Reportar ganancia (+)
              </button>
              <button className="ghost" disabled={busy || !canWrite || !data.isBot} onClick={() => run("Pérdida del bot", () => writes.strategy.executeTrade(-units(pnl)))}>
                Reportar pérdida (−)
              </button>
            </div>
            <div className="row">
              <button className="ghost" disabled={busy || !canWrite} onClick={() => run("Harvest", () => writes.vault.harvest())}>
                Reportar y cobrar fee (harvest)
              </button>
              <button className="ghost" disabled={busy || !canWrite} onClick={() => run("Health check", () => writes.vault.checkStrategyHealth(CONFIG.strategy))}>
                Chequear drawdown
              </button>
              <button className="danger" disabled={busy || !canWrite || !data.isGuardian} onClick={() => run("Emergencia", () => writes.vault.emergencyRecallAll())}>
                Emergencia (guardián)
              </button>
            </div>
            <p className="hint">Los botones de operador/bot/guardián se habilitan solo si tu cuenta tiene ese rol on-chain.</p>
          </section>
        </>
      )}

      <section className="card">
        <h2>Actividad</h2>
        {log.length === 0 && <p className="hint">Sin actividad todavía.</p>}
        <ul className="log">
          {log.map((l, i) => (
            <li key={i}>
              <span>{l.t}</span> {l.msg}{" "}
              {l.hash && CONFIG.explorer && (
                <a href={`${CONFIG.explorer}/tx/${l.hash}`} target="_blank" rel="noreferrer">ver tx</a>
              )}
            </li>
          ))}
        </ul>
      </section>

      <p className="hint">
        Contratos verificados:{" "}
        <a href={`${CONFIG.explorer}/address/${CONFIG.vault}#code`} target="_blank" rel="noreferrer">vault</a> ·{" "}
        <a href={`${CONFIG.explorer}/address/${CONFIG.strategy}#code`} target="_blank" rel="noreferrer">estrategia</a> ·{" "}
        <a href={`${CONFIG.explorer}/address/${CONFIG.asset}#code`} target="_blank" rel="noreferrer">token</a> ·{" "}
        <a href={CONFIG.repo} target="_blank" rel="noreferrer">código en GitHub</a>
      </p>
    </main>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

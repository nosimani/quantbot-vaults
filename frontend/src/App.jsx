import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, formatUnits, parseUnits, MaxUint256 } from "ethers";
import { CONFIG, isConfigured } from "./config.js";
import { VAULT_ABI, ERC20_ABI, STRATEGY_ABI } from "./abi.js";

const DEC = 6; // mUSDC
const SHARE_DEC = 9; // 6 decimales del activo + offset 3 del vault
const fmt = (v, d = DEC) => Number(formatUnits(v ?? 0n, d)).toLocaleString("es-AR", { maximumFractionDigits: 4 });

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

  const addLog = (msg, hash) => setLog((l) => [{ msg, hash, t: new Date().toLocaleTimeString() }, ...l].slice(0, 12));

  const contracts = useMemo(() => {
    if (!signer || !isConfigured()) return null;
    return {
      vault: new Contract(CONFIG.vault, VAULT_ABI, signer),
      token: new Contract(CONFIG.asset, ERC20_ABI, signer),
      strategy: new Contract(CONFIG.strategy, STRATEGY_ABI, signer),
    };
  }, [signer]);

  const connect = async () => {
    if (!window.ethereum) return alert("Instalá MetaMask u otra wallet EVM.");
    const provider = new BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const net = await provider.getNetwork();
    setChainOk(Number(net.chainId) === CONFIG.chainId);
    const s = await provider.getSigner();
    setSigner(s);
    setAccount(await s.getAddress());
  };

  const refresh = useCallback(async () => {
    if (!contracts || !account) return;
    const { vault, token, strategy } = contracts;
    const [total, idle, supply, myShares, paused, fee, balance, allowance, stratAssets, info, opRole, grdRole, botRole] =
      await Promise.all([
        vault.totalAssets(),
        vault.idleAssets(),
        vault.totalSupply(),
        vault.balanceOf(account),
        vault.paused(),
        vault.performanceFeeBps(),
        token.balanceOf(account),
        token.allowance(account, CONFIG.vault),
        strategy.totalAssets(),
        vault.strategyInfo(CONFIG.strategy),
        vault.OPERATOR_ROLE(),
        vault.GUARDIAN_ROLE(),
        strategy.BOT_ROLE(),
      ]);
    const myAssets = await vault.convertToAssets(myShares);
    const maxRedeem = await vault.maxRedeem(account);
    const [isOperator, isGuardian, isBot] = await Promise.all([
      vault.hasRole(opRole, account),
      vault.hasRole(grdRole, account),
      strategy.hasRole(botRole, account),
    ]);
    setData({ total, idle, supply, myShares, myAssets, maxRedeem, paused, fee, balance, allowance, stratAssets, info, isOperator, isGuardian, isBot });
  }, [contracts, account]);

  useEffect(() => {
    refresh().catch((e) => addLog(`Error al leer datos: ${e.shortMessage || e.message}`));
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

  const needsApproval = data && units(amount) > data.allowance;
  const price = data && data.supply > 0n ? (Number(formatUnits(data.total, DEC)) / Number(formatUnits(data.supply, SHARE_DEC))).toFixed(6) : "1.000000";

  return (
    <main className="wrap">
      <header>
        <div>
          <h1>QuantBot Vaults</h1>
          <p className="sub">Bóvedas ERC-4626 para estrategias de trading algorítmico on-chain</p>
        </div>
        {account ? (
          <span className="pill">{account.slice(0, 6)}…{account.slice(-4)}</span>
        ) : (
          <button onClick={connect}>Conectar wallet</button>
        )}
      </header>

      {!chainOk && <p className="card warn">Cambiá la red de tu wallet a chainId {CONFIG.chainId}.</p>}

      {data && (
        <>
          <section className="grid">
            <Stat label="TVL (totalAssets)" value={`${fmt(data.total)} mUSDC`} />
            <Stat label="Liquidez en vault" value={`${fmt(data.idle)} mUSDC`} />
            <Stat label="En estrategia (bot)" value={`${fmt(data.stratAssets)} mUSDC`} />
            <Stat label="Precio por share" value={`${price} mUSDC`} />
            <Stat label="Fee de performance" value={`${Number(data.fee) / 100} %`} />
            <Stat label="Estado" value={data.paused ? "⏸ Pausado" : "● Activo"} />
          </section>

          <section className="card">
            <h2>Mi posición</h2>
            <p>Saldo mUSDC: <b>{fmt(data.balance)}</b> · Shares: <b>{fmt(data.myShares, SHARE_DEC)}</b> · Valor: <b>{fmt(data.myAssets)} mUSDC</b></p>
            <div className="row">
              <button disabled={busy} onClick={() => run("Faucet", () => contracts.token.faucet())}>Pedir 10.000 mUSDC (faucet)</button>
            </div>
            <div className="row">
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              {needsApproval ? (
                <button disabled={busy} onClick={() => run("Approve", () => contracts.token.approve(CONFIG.vault, MaxUint256))}>1. Aprobar</button>
              ) : (
                <button disabled={busy || data.paused} onClick={() => run("Depósito", () => contracts.vault.deposit(units(amount), account))}>Depositar</button>
              )}
              <button className="ghost" disabled={busy || data.maxRedeem === 0n} onClick={() => run("Retiro", () => contracts.vault.redeem(data.maxRedeem, account, account))}>
                Retirar máximo disponible
              </button>
            </div>
            <p className="hint">El retiro está limitado por la liquidez del vault ({fmt(data.idle)} mUSDC). Incluso en pausa se puede retirar.</p>
          </section>

          <section className="card">
            <h2>Estrategia (bot)</h2>
            <p>
              Asignado (deuda): <b>{fmt(data.info.debt)}</b> mUSDC · Tope: <b>{Number(data.info.maxAllocationBps) / 100} %</b> ·{" "}
              {data.info.active ? "activa" : "desactivada por circuit breaker/guardián"}
            </p>
            <div className="row">
              <input value={allocAmount} onChange={(e) => setAllocAmount(e.target.value)} inputMode="decimal" />
              <button disabled={busy || !data.isOperator} onClick={() => run("Allocate", () => contracts.vault.allocate(CONFIG.strategy, units(allocAmount)))}>Asignar al bot</button>
              <button className="ghost" disabled={busy || !data.isOperator} onClick={() => run("Recall", () => contracts.vault.recall(CONFIG.strategy, data.stratAssets))}>Recuperar todo</button>
            </div>
            <div className="row">
              <input value={pnl} onChange={(e) => setPnl(e.target.value)} inputMode="decimal" />
              <button disabled={busy || !data.isBot} onClick={() => run("Ganancia del bot", async () => {
                const allowance = await contracts.token.allowance(account, CONFIG.strategy);
                if (allowance < units(pnl)) await (await contracts.token.approve(CONFIG.strategy, MaxUint256)).wait();
                return contracts.strategy.executeTrade(units(pnl));
              })}>Reportar ganancia (+)</button>
              <button className="ghost" disabled={busy || !data.isBot} onClick={() => run("Pérdida del bot", () => contracts.strategy.executeTrade(-units(pnl)))}>Reportar pérdida (−)</button>
            </div>
            <div className="row">
              <button className="ghost" disabled={busy} onClick={() => run("Harvest", () => contracts.vault.harvest())}>Cobrar fee (harvest)</button>
              <button className="ghost" disabled={busy} onClick={() => run("Health check", () => contracts.vault.checkStrategyHealth(CONFIG.strategy))}>Chequear drawdown</button>
              <button className="danger" disabled={busy || !data.isGuardian} onClick={() => run("Emergencia", () => contracts.vault.emergencyRecallAll())}>Emergencia (guardián)</button>
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

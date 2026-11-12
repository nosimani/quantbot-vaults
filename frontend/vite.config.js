import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" permite publicar el build en cualquier ruta (GitHub Pages, Vercel, Netlify).
export default defineConfig({
  base: "./",
  plugins: [react()],
});

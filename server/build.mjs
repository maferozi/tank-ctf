// Production build: `npm run build -w server` -> dist/index.js, run with plain node
// (`npm start -w server`). esbuild bundles the server and the @tank/shared workspace
// (TypeScript source, not published) into one ES module. Every other package (colyseus,
// msgpackr, native addons like node-datachannel, ...) stays a normal import, loaded from
// node_modules at runtime. No type checking here: that's `npm run typecheck`.
import { build } from "esbuild";

const BUNDLED = /^@tank\/shared(\/|$)/;

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  tsconfig: "tsconfig.json", // experimentalDecorators / useDefineForClassFields, as tsx uses
  sourcemap: true, // crash stack traces point at the .ts lines (node --enable-source-maps)
  logLevel: "info",
  plugins: [
    {
      name: "external-packages",
      setup(b) {
        // Any bare import (a package name, not a ./path) except our own workspace code.
        b.onResolve({ filter: /^[^./]/ }, (args) => (BUNDLED.test(args.path) ? undefined : { path: args.path, external: true }));
      },
    },
  ],
});

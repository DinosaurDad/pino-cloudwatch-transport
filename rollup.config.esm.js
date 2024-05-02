import typescript from "@rollup/plugin-typescript"
import resolve from "@rollup/plugin-node-resolve"
import json from "@rollup/plugin-json"
import commonjs from "@rollup/plugin-commonjs"
import { visualizer } from "rollup-plugin-visualizer"

export default {
  input: "index.ts",
  output: {
    // dir: "dist-esm",
    file: "dist/index.mjs",
    format: "es",
    generatedCode: "es2015",
  },

  external: [
    "@aws-sdk/client-cloudwatch-logs",
    "pino-abstract-transport"
  ],
  plugins: [
    typescript(),
    resolve({
      preferBuiltins: true,
      browser: false,
      // dedupe: ["aws-sdk"]
    }),
    json(),
    commonjs(),
    visualizer(),
  ]
};

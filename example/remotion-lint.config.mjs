/** @type {import("remotion-lint").UserConfig} */
export default {
  entryPoint: "src/index.ts",
  layout: { forbidden: ["\\bnightjar\\b", "\\btodo\\b"] },
};

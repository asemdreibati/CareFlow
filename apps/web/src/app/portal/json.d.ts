/** Lets the i18n parity spec import the portal bundles directly (esbuild handles JSON natively). */
declare module '*.json' {
  const value: Record<string, unknown>;
  export default value;
}

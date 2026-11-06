declare module '*.css' {}

/** plotly.js's prebuilt bundle, which ships no types; PlotlyChart types the slice it uses. */
declare module 'plotly.js-dist-min' {
  const plotly: unknown;
  export default plotly;
}

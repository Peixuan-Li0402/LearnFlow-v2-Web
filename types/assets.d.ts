declare module "*?url" {
  const url: string;
  export default url;
}

declare module "pdfjs-dist/build/pdf.mjs" {
  export * from "pdfjs-dist";
}

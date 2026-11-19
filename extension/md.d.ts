// Markdown files are bundled as text into the MCP server (esbuild --loader:.md=text).
declare module '*.md' {
  const text: string;
  export default text;
}

declare module 'imagetracerjs' {
  const ImageTracer: { imagedataToSVG(data: ImageData, options?: Record<string, any>): string };
  export default ImageTracer;
}

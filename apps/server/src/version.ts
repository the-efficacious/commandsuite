declare const __PKG_VERSION__: string | undefined;

export const SERVER_VERSION: string =
  typeof __PKG_VERSION__ === 'string' ? __PKG_VERSION__ : '0.0.0-dev';

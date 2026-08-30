declare const __PKG_VERSION__: string | undefined;
declare const __BUILD_SOURCE__: 'npm' | 'main' | undefined;
declare const __SOURCE_FINGERPRINT__: string | undefined;

const packageVersion = typeof __PKG_VERSION__ === 'string' ? __PKG_VERSION__ : '0.0.0-dev';
export const SERVER_BUILD_SOURCE: 'npm' | 'main' =
  typeof __BUILD_SOURCE__ === 'string' && __BUILD_SOURCE__ === 'npm' ? 'npm' : 'main';
export const SERVER_SOURCE_FINGERPRINT =
  typeof __SOURCE_FINGERPRINT__ === 'string' ? __SOURCE_FINGERPRINT__ : 'unknown';
export const SERVER_VERSION =
  SERVER_BUILD_SOURCE === 'npm'
    ? packageVersion
    : `${packageVersion}+main.${SERVER_SOURCE_FINGERPRINT}`;

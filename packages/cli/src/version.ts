declare const __PKG_VERSION__: string | undefined;
declare const __BUILD_SOURCE__: 'npm' | 'main' | undefined;
declare const __SOURCE_FINGERPRINT__: string | undefined;

const packageVersion = typeof __PKG_VERSION__ === 'string' ? __PKG_VERSION__ : '0.0.0-dev';
export const CLI_BUILD_SOURCE: 'npm' | 'main' =
  typeof __BUILD_SOURCE__ === 'string' && __BUILD_SOURCE__ === 'npm' ? 'npm' : 'main';
export const CLI_SOURCE_FINGERPRINT =
  typeof __SOURCE_FINGERPRINT__ === 'string' ? __SOURCE_FINGERPRINT__ : 'unknown';
export const CLI_VERSION =
  CLI_BUILD_SOURCE === 'npm' ? packageVersion : `${packageVersion}+main.${CLI_SOURCE_FINGERPRINT}`;

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // 单测只覆盖 domain/（纯业务逻辑，不 import ICE 家族），所以不需要 jsdom，
        // 也不走工程的 tsconfig（那份是给 webpack 的 esnext/dom 配置）。
        tsconfig: {
          module: 'commonjs',
          target: 'es2019',
          lib: ['es2019'],
          types: ['jest'],
          esModuleInterop: true,
          strict: false,
          skipLibCheck: true,
        },
      },
    ],
  },
  collectCoverageFrom: ['src/domain/**/*.ts'],
};

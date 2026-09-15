/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // 单测主要覆盖 domain/（纯业务逻辑，不 import ICE 家族），所以不需要 jsdom，
        // 也不走工程的 tsconfig（那份是给 webpack 的 esnext/dom 配置）。
        //
        // `dom` 只加在 **lib** 上：有几处 view 层函数（如 canvas-viewport 的
        // sizeCanvasToParent）不需要真实 DOM，用假对象就能测，但签名里出现
        // HTMLCanvasElement 这类类型，不给 dom lib 编译不过。
        // testEnvironment 仍是 node —— 没有引入 jsdom。
        tsconfig: {
          module: 'commonjs',
          target: 'es2019',
          lib: ['es2019', 'dom'],
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

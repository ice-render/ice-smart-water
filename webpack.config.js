const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

const WORKSPACE = path.resolve(__dirname, '..');

/**
 * ICE 家族四件套在本地是**四个并列的仓库**，不是一个 monorepo。
 *
 * 每个包的 `node_modules` 里还各自躺着一份自己装的 `ice-render`（版本甚至不同：2.3.0 / 2.3.2），
 * 直接用 node 的解析规则打包，会解析出**多份引擎实例** —— 引擎的类身份（`typeId` 注册表、
 * `instanceof`、事件总线）就会错位：`ice-entity-designer` 造出来的图元在 `ice-chart` 眼里
 * 不是"同一个 ICE 的组件"。
 *
 * 所以这里把四个包**全部 alias 到同级仓库目录**，强制整个工程只有一份 `ice-render`。
 * 副作用是好的：改完兄弟仓库的源码 `npm run build` 一下，本工程立刻吃到新版本。
 */
const family = {
  'ice-render': path.resolve(WORKSPACE, 'ice-render'),
  '@damoqiongqiu/ice-chart': path.resolve(WORKSPACE, 'ice-chart'),
  'ice-web-components': path.resolve(WORKSPACE, 'ice-web-components'),
  'ice-entity-designer': path.resolve(WORKSPACE, 'ice-entity-designer'),
};

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';

  return {
    /**
     * **单入口**：整个系统只有一个 HTML（`index.html`），所有功能都在这张画布外壳里 ——
     * 工艺流程图 / 运行数据 / 符号库是壳里的三个页签，不是三个页面。
     */
    entry: {
      // 入口只挂登录门 + 启动遮罩；控制台（外壳 / 12 个页签 / 设计器 / 图表）是异步 chunk（见 boot.ts）
      boot: path.resolve(__dirname, 'src/entries/boot.ts'),
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: isProd ? '[name].[contenthash:8].js' : '[name].js',
      // 异步 chunk（console）也要带内容哈希：改一版就换名，配合 Pages 的 max-age=600 也够用
      chunkFilename: isProd ? '[name].[contenthash:8].js' : '[name].js',
      clean: true,
    },
    resolve: {
      extensions: ['.ts', '.js'],
      alias: family,
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [
            {
              // 只转译不做类型检查（类型门禁交给 `npm run types:check`），构建快得多
              loader: 'ts-loader',
              options: { transpileOnly: true },
            },
          ],
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: path.resolve(__dirname, 'public/index.html'),
        filename: 'index.html',
        chunks: ['boot'],
      }),
    ],
    // 打包进来的是四个库（引擎 + 图表 + 控件 + 设计器），体积天然大，别刷警告
    performance: { hints: false },
    devServer: {
      static: { directory: path.resolve(__dirname, 'public') },
      port: 8092,
      open: false,
      hot: true,
    },
    devtool: isProd ? false : 'eval-source-map',
  };
};

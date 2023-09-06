const HtmlWebpackPlugin = require("html-webpack-plugin");
const path = require('path');

module.exports = [
  {
    entry: './src/main/main.ts',
    target: "electron-main",
    output: {
      filename: 'main.js',
      path: path.resolve(__dirname, 'dist'),
    },
    module: {
      rules: [{
        test: /\.ts?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      }]
    },
  },
  {
    entry: './src/main/preload.ts',
    target: "electron-preload",
    output: {
      filename: 'preload.js',
      path: path.resolve(__dirname, 'dist'),
    },
    module: {
      rules: [{
        test: /\.ts?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      }]
    },
  },
  {
    entry: './src/renderer/index.ts',
    devtool: "source-map",
    target: 'electron-renderer',
    module: {
      rules: [
        {
          test: /\.ts?$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
        {
          test: /\.css$/i,
          use: ["style-loader", "css-loader"],
        },
      ],
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
      alias: {
        // jsmediatags: 'jsmediatags/dist/jsmediatags.min.js',
        jsmediatags: 'jsmediatags/build2/jsmediatags.js',
      },
    },
    output: {
      filename: 'bundle.js',
      path: path.resolve(__dirname, 'dist'),
      library: 'NanoApp',
      globalObject: 'self',
    },

    plugins: [
      new HtmlWebpackPlugin({
          title: '', 
          template: 'src/renderer/index.html' })
    ],

    devServer: {
      static: path.join(__dirname, "dist"),
      compress: true,
      port: 4000,
    },

    performance: {
      maxAssetSize: 1048576,
      maxEntrypointSize: 1048576,
    },
  }
];

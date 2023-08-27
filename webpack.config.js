const HtmlWebpackPlugin = require("html-webpack-plugin");
const path = require('path');

module.exports = {
  entry: './src/index.ts',
  devtool: "source-map",
  target: 'web',
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
      jsmediatags: 'jsmediatags/dist/jsmediatags.min.js',
    },
  },
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
    library: 'NanoApp',
  },

  plugins: [
    new HtmlWebpackPlugin({
        title: '', 
        template: 'src/index.html' })
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
};

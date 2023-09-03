declare module 'JSInterpreter';
export as namespace JSInterpreter;


export type JSValue = JSObject|boolean|number|string|undefined|null;

export interface JSObject {
  getter: () => any; // ??
  setter: (any) => void; // ??
  properties: object;
  proto: any;
  data?: Date|RegExp|boolean|number|string|null;
}

export default class Interpreter {
  static REGEXP_MODE: number;

  constructor(code: string|AstNode);

  parse_(inpt: string, opts?: ParserOptions): AstNode;
  appendCode(code: string|AstNode): void;
  step(): boolean;
  run(): boolean;
  get value(): JSValue;

  get globalObject(): JSObject;
  nativeToPseudo(nativeObj: any): JSValue;
  pseudoToNative(pseudoObj: JSValue, object?: opt_cycles): object|boolean|number|string|undefined|null;

  createNativeFunction(nativeFunc: Function, isConstructor?: boolean): JSObject;
  getProperty(obj: JSValue, name: JSValue): JSValue|undefined;
  hasProperty(obj: JSObject, name: JSValue): boolean;
  setProperty(obj: JSValue, name: JSValue, value: JSValue, opt_descriptor?: any): JSObject|undefined;
}

export class AstNode {
  type: string;
  start?: TokenLocation;
  end?: TokenLocation;
}

export class TokenLocation {
  line: number;
  column: number;
}

export interface ParserOptions {
  // JS-Interpreter change:
  // `ecmaVersion` option has been removed along with all cases where
  // it is checked.  In this version of Acorn it was limited to 3 or 5,
  // and there's no use case for 3 with JS-Interpreter.
  // -- Neil Fraser, December 2022.

  // Turn on `strictSemicolons` to prevent the parser from doing
  // automatic semicolon insertion.
  strictSemicolons: boolean,
  // When `allowTrailingCommas` is false, the parser will not allow
  // trailing commas in array and object literals.
  allowTrailingCommas: boolean,
  // By default, reserved words are not enforced. Enable
  // `forbidReserved` to enforce them. When this option has the
  // value "everywhere", reserved words and keywords can also not be
  // used as property names.
  forbidReserved: boolean,
  // When enabled, a return at the top level is not considered an
  // error.
  allowReturnOutsideFunction: boolean,
  // When `locations` is on, `loc` properties holding objects with
  // `start` and `end` properties in `{line, column}` form (with
  // line being 1-based and column 0-based) will be attached to the
  // nodes.
  locations: boolean,
  // A function can be passed as `onComment` option, which will
  // cause Acorn to call that function with `(block, text, start,
  // end)` parameters whenever a comment is skipped. `block` is a
  // boolean indicating whether this is a block (`/* */`) comment,
  // `text` is the content of the comment, and `start` and `end` are
  // character offsets that denote the start and end of the comment.
  // When the `locations` option is on, two more parameters are
  // passed, the full `{line, column}` locations of the start and
  // end of the comments. Note that you are not allowed to call the
  // parser from the callback—that will corrupt its internal state.
  onComment: ((block: boolean, text: string, start: number, end: number) => void)|null,
  // Nodes have their start and end characters offsets recorded in
  // `start` and `end` properties (directly on the node, rather than
  // the `loc` object, which holds line/column data. To also add a
  // [semi-standardized][range] `range` property holding a `[start,
  // end]` array with the same numbers, set the `ranges` option to
  // `true`.
  //
  // [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
  ranges: boolean,
  // It is possible to parse multiple files into a single AST by
  // passing the tree produced by parsing the first file as
  // `program` option in subsequent parses. This will add the
  // toplevel forms of the parsed file to the `Program` (top) node
  // of an existing parse tree.
  program: Program|null,
  // When `locations` is on, you can pass this to record the source
  // file in every node's `loc` object.
  sourceFile: string|null,
  // This value, if given, is stored in every node, whether
  // `locations` is on or off.
  directSourceFile: string|null,
};

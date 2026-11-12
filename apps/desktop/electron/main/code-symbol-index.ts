import path from "node:path";
import ts from "typescript";
import { loadCodeSymbolProject } from "./code-symbol-project";
import { searchCodePurpose, type CodePurposeRequest, type CodePurposeResult, type PurposeImplementation } from "./code-purpose-search";

export type CodeSymbolRequest =
  | { name: string; file?: string; line?: number; column?: number; callOffset?: number; purpose?: never; hints?: never; scope?: never }
  | CodePurposeRequest;

type Location = { file: string; startLine: number; endLine: number };
type CallSite = { file: string; line: number; column: number };
type CallPage = { calls: CallSite[]; totalCalls: number; nextCallOffset: number | null };
export type Coverage = { partial: boolean; reasons: string[]; indexedFiles: number; limitations: string };
export type CodeSymbolResult = CodePurposeResult | ({ coverage: Coverage } & (
  | ({ status: "found"; definition: Location & { text?: string } } & CallPage)
  | { status: "ambiguous"; candidates: (Location & { startColumn: number })[]; totalCandidates: number; hint: string }
  | { status: "not_found" | "incomplete" }
));

const PAGE_SIZE = 50;
const LIMITATIONS = "Static direct calls in indexed JS/TS source only. Dynamic dispatch, callbacks, reflection, unresolved imports and external dependencies can hide callers. Dependency, build, temporary and hidden directories and symlinks are excluded.";

function expressionValue(expr: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr) ||
    ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    expr = expr.expression;
  }
  return expr;
}

function namedToken(node: ts.Node | undefined): ts.Identifier | ts.PrivateIdentifier | ts.StringLiteralLike | undefined {
  if (!node) return;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) return node;
  if (ts.isFunctionExpression(node)) return node.name;
  if (ts.isPropertyAccessExpression(node)) return node.name;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression;
  if (ts.isComputedPropertyName(node) && ts.isStringLiteralLike(node.expression)) return node.expression;
  return undefined;
}

type Implementation = PurposeImplementation;

function namedImplementation(node: ts.Node, requested: string | undefined, checker: ts.TypeChecker): Implementation | undefined {
  let name: ts.Node | undefined;
  let startNode = node;
  let body: ts.Node | undefined;
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) {
    if (!node.body) return;
    name = node.name;
    body = node;
  } else if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
    const initializer = node.initializer && expressionValue(node.initializer);
    if (!initializer || (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer))) return;
    name = node.name;
    body = initializer;
    if (ts.isVariableDeclarationList(node.parent) && node.parent.declarations.length === 1 && ts.isVariableStatement(node.parent.parent)) {
      startNode = node.parent.parent;
    }
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const value = expressionValue(node.right);
    if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return;
    name = namedToken(node.left);
    body = value;
    if (ts.isExpressionStatement(node.parent)) startNode = node.parent;
  } else {
    return;
  }
  const token = namedToken(name);
  if (!token || (requested !== undefined && token.text !== requested)) return;
  const source = node.getSourceFile();
  let start = startNode.getStart(source, true);
  const nodes = new Set<ts.Node>([node, body]);
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    for (const decl of checker.getSymbolAtLocation(token)?.declarations ?? []) {
      if (decl.getSourceFile() === source && (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) && !decl.body) {
        nodes.add(decl);
        start = Math.min(start, decl.getStart(source, true));
      }
    }
  }
  return { name: token.text, token, source, start, fullStart: startNode.getFullStart(), end: startNode.end, nodes };
}

const relativeFile = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");
const lineAt = (file: ts.SourceFile, offset: number) => file.getLineAndCharacterOfPosition(offset).line + 1;

function walk(node: ts.Node, visitor: (node: ts.Node) => void) {
  visitor(node);
  ts.forEachChild(node, child => walk(child, visitor));
}

// Track possible spellings syntactically to avoid asking the checker for every
// call signature in a large repository. Only a physical declaration match below
// can actually contribute a call, including for import/export and local aliases.
function recordAlias(node: ts.Node, edges: Map<string, Set<string>>) {
  let from: string | undefined;
  let to: string | undefined;
  if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node) || ts.isBindingElement(node)) {
    from = namedToken(node.propertyName)?.text;
    to = namedToken(node.name)?.text;
  } else if (ts.isImportClause(node)) {
    from = "default";
    to = node.name?.text;
  } else if (ts.isExportAssignment(node)) {
    from = namedToken(expressionValue(node.expression))?.text;
    to = "default";
  } else if (ts.isFunctionDeclaration(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) {
    from = node.name?.text;
    to = "default";
  } else if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && node.initializer) {
    const value = expressionValue(node.initializer);
    from = ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "require"
      ? "default" : namedToken(value)?.text;
    to = namedToken(node.name)?.text;
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    from = namedToken(expressionValue(node.right))?.text;
    const left = node.left;
    to = ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) &&
      left.expression.text === "module" && left.name.text === "exports" ? "default" : namedToken(left)?.text;
  }
  if (!from || !to || from === to) return;
  let destinations = edges.get(from);
  if (!destinations) edges.set(from, destinations = new Set());
  destinations.add(to);
}

function findCalls(
  root: string, sources: ts.SourceFile[], checker: ts.TypeChecker, selected: Implementation,
  requested: string, edges: Map<string, Set<string>>, offset: number,
): CallPage {
  const spellings = new Set([requested]);
  for (const spelling of spellings) {
    for (const alias of edges.get(spelling) ?? []) spellings.add(alias);
  }
  const calls: CallSite[] = [];
  let totalCalls = 0;
  for (const source of sources) {
    const file = relativeFile(root, source.fileName);
    const positions: number[] = [];
    walk(source, node => {
      if (!ts.isCallExpression(node)) return;
      const token = namedToken(expressionValue(node.expression));
      if (!token || !spellings.has(token.text)) return;
      let symbol = checker.getSymbolAtLocation(token);
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
      const declarations = symbol?.declarations;
      if (declarations?.some(decl => selected.nodes.has(decl))) {
        // An overload set is one implementation; a union of unrelated methods is not.
        if (declarations.some(decl => !selected.nodes.has(decl))) return;
      } else {
        const signature = checker.getResolvedSignature(node)?.declaration;
        if (!signature || !selected.nodes.has(signature)) return;
      }
      positions.push(token.getStart(source));
    });
    const pageStart = Math.max(0, offset - totalCalls);
    const pageEnd = offset + PAGE_SIZE - totalCalls;
    if (pageEnd > pageStart && pageStart < positions.length) {
      positions.sort((a, b) => a - b);
      for (const position of positions.slice(pageStart, pageEnd)) {
        const pos = source.getLineAndCharacterOfPosition(position);
        calls.push({ file, line: pos.line + 1, column: pos.character + 1 });
      }
    }
    totalCalls += positions.length;
  }
  return { calls, totalCalls, nextCallOffset: offset + PAGE_SIZE < totalCalls ? offset + PAGE_SIZE : null };
}

function comparePaths(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function lookupCodeSymbol(root: string, request: CodeSymbolRequest): CodeSymbolResult {
  root = path.resolve(root);
  const { checker, projectSources, reasons, indexedFiles } = loadCodeSymbolProject(root);
  const coverage: Coverage = { partial: reasons.size > 0, reasons: [...reasons].sort(), indexedFiles, limitations: LIMITATIONS };
  if (typeof request.purpose === "string") {
    const implementations: Implementation[] = [];
    for (const source of projectSources) {
      const represented = new Set<ts.Node>();
      walk(source, node => {
        if (represented.has(node)) return;
        const impl = namedImplementation(node, undefined, checker);
        if (!impl) return;
        for (const declaration of impl.nodes) represented.add(declaration);
        implementations.push(impl);
      });
    }
    return searchCodePurpose(root, request, projectSources, checker, implementations, coverage);
  }
  const edges = new Map<string, Set<string>>();
  const candidates: { impl: Implementation; location: Location }[] = [];
  const wantedFile = request.file === undefined ? undefined : path.resolve(root, request.file);
  for (const source of projectSources) {
    const inScope = !wantedFile || path.relative(wantedFile, source.fileName) === "";
    const represented = new Set<ts.Node>();
    walk(source, node => {
      recordAlias(node, edges);
      if (!inScope || represented.has(node)) return;
      const impl = namedImplementation(node, request.name, checker);
      if (!impl) return;
      for (const declaration of impl.nodes) represented.add(declaration);
      const location = {
        file: relativeFile(root, source.fileName),
        startLine: lineAt(source, impl.start), endLine: lineAt(source, impl.end - 1),
      };
      if (request.line !== undefined && (request.line < location.startLine || request.line > location.endLine)) return;
      if (request.column !== undefined && (location.startLine !== request.line ||
        source.getLineAndCharacterOfPosition(impl.start).character + 1 !== request.column)) return;
      candidates.push({ impl, location });
    });
  }
  if (!candidates.length) return { status: coverage.partial ? "incomplete" : "not_found", coverage };
  const exactStart = request.line === undefined ? [] : candidates.filter(c => c.location.startLine === request.line);
  const matches = exactStart.length ? exactStart : candidates;
  if (matches.length > 1) {
    const locations = matches.map(({ impl, location }) => ({
      ...location, startColumn: impl.source.getLineAndCharacterOfPosition(impl.start).character + 1,
    })).sort((a, b) => comparePaths(a.file, b.file) || a.startLine - b.startLine || a.startColumn - b.startColumn);
    const sameLine = locations.some((c, i) => i > 0 && c.file === locations[i - 1].file && c.startLine === locations[i - 1].startLine);
    const hint = sameLine ? "Select a candidate with file, line and column using startLine and startColumn." : "Select a candidate with file and line.";
    return { status: "ambiguous", candidates: locations.slice(0, PAGE_SIZE), totalCandidates: locations.length, hint, coverage };
  }
  const { impl, location } = matches[0];
  const offset = Math.max(0, request.callOffset ?? 0);
  const definition = offset === 0 ? { ...location, text: impl.source.text.slice(impl.start, impl.end) } : location;
  return {
    status: "found", definition, ...findCalls(root, projectSources, checker, impl, request.name, edges, offset), coverage,
  };
}

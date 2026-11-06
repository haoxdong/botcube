import ts from 'typescript';

const owned = new Set(['Presence', 'Swap', 'Fade', 'Collapse', 'CollapseList', 'AnimatePresence']);
const lifecycle = new Set(['Sheet', 'StepSheet', 'Fade', 'Collapse', 'CollapseItem', 'FadeItem', 'Collapsible', 'Fading']);
const noBox = new Set(['MomentEnds', 'ComposerFilePicker', 'ChatSurface']);

function elementName(node: ts.Node, source: ts.SourceFile): string | null {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText(source);
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText(source);
  return null;
}

function ownerOf(node: ts.Node, source: ts.SourceFile): string | null {
  for (let parent = node.parent; !ts.isSourceFile(parent); parent = parent.parent) {
    const name = elementName(parent, source);
    if (name !== null) return owned.has(name) ? name : null;
  }
  return null;
}

function animated(node: ts.Node, source: ts.SourceFile): boolean {
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return false;
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return opening.attributes.properties.some((property) =>
    ts.isJsxAttribute(property) && property.name.getText(source) === 'exit' ||
    ts.isJsxSpreadAttribute(property) && property.expression.getText(source) === 'presenceMotion');
}

function providerBoundary(node: ts.Node, source: ts.SourceFile): boolean {
  if (!ts.isJsxElement(node) || elementName(node, source) !== 'Suspense') return false;
  const children = node.children.filter((child) => !ts.isJsxText(child));
  return children.length > 0 && children.every((child) => noBox.has(elementName(child, source) ?? '') || lifecycle.has(elementName(child, source) ?? ''));
}

function invisible(node: ts.Node): boolean {
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return false;
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return opening.attributes.properties.some((property) => ts.isJsxAttribute(property) && (
    property.name.getText() === 'data-chat-earlier' ||
    (property.name.getText() === 'hidden' && (!property.initializer || ts.isJsxExpression(property.initializer) && property.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword)) ||
    (property.name.getText() === 'type' && property.initializer && ts.isStringLiteral(property.initializer) && property.initializer.text === 'hidden')
  ));
}

function roots(node: ts.Node): ts.Node[] {
  if (ts.isParenthesizedExpression(node)) return roots(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return roots(node.right);
  if (ts.isConditionalExpression(node)) return [...roots(node.whenTrue), ...roots(node.whenFalse)];
  if (ts.isJsxFragment(node)) return node.children.flatMap(roots);
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) ? [node] : [];
}

export function bareVisibleMounts(text: string, file = 'fixture.tsx') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const failures: { line: number; element: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent) &&
      (ts.isConditionalExpression(node.expression) || ts.isBinaryExpression(node.expression)) ) {
      for (const root of roots(node.expression)) {
        const name = elementName(root, source);
        if (name === null || lifecycle.has(name) || noBox.has(name) || invisible(root) || providerBoundary(root, source)) continue;
        const owner = ownerOf(node, source);
        if (owner !== null && (animated(root, source) || ['Swap', 'Collapse', 'Fade'].includes(owner))) continue;
        failures.push({ line: source.getLineAndCharacterOfPosition(root.getStart(source)).line + 1, element: name });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return failures;
}

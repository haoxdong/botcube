import ts from 'typescript';

export function handRolls(source: string) {
  const file = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const counts: Record<string, number> = {};
  const add = (name: string) => { counts[name] = (counts[name] ?? 0) + 1; };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text : member(node.expression);
      if (name === 'requestAnimationFrame' || name === 'animate' || name === 'animateMini') add(name);
      if (name === 'scroll' || name === 'scrollTo' || name === 'scrollBy' || name === 'scrollIntoView') add('scroll-write');
    }
    if (ts.isNewExpression(node) && (ts.isIdentifier(node.expression) ? node.expression.text : member(node.expression)) === 'ResizeObserver') add('ResizeObserver');
    if (scrollAssignment(node)) add('scroll-write');
    ts.forEachChild(node, visit);
  };
  visit(file);
  return counts;
}

function member(node: ts.Node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
  return undefined;
}

function scrollAssignment(node: ts.Node) {
  const target = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? node.left
    : (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) ? node.operand : undefined;
  return target !== undefined && ['scrollTop', 'scrollLeft'].includes(member(target) ?? '');
}

/**
 * ESLint rule: must-use-result
 *
 * Ensures neverthrow Result/ResultAsync values are handled — not silently ignored.
 * Recognizes .match(), .unwrapOr(), ._unsafeUnwrap(), .isErr(), and .isOk() as
 * valid handling methods. Results that are returned are also considered handled.
 *
 * Based on @ninoseki/eslint-plugin-neverthrow (MIT, Copyright 2024 Manabu Niseki).
 * Vendored with .isErr()/.isOk() added to handledMethods.
 */

import { ESLintUtils } from '@typescript-eslint/utils'

function matchAny(nodeTypes) {
  return `:matches(${nodeTypes.join(', ')})`
}

const resultSelector = matchAny(['CallExpression', 'NewExpression'])

/** Properties that identify a type as Result-like. */
const resultProperties = ['mapErr', 'map', 'andThen', 'orElse', 'match', 'unwrapOr']

/** Methods that count as "handling" a Result. */
const handledMethods = ['match', 'unwrapOr', '_unsafeUnwrap', 'isErr', 'isOk']

function isResultLike(checker, parserServices, node) {
  if (!node) return false
  const tsNode = parserServices.esTreeNodeToTSNodeMap.get(node)
  const type = checker.getTypeAtLocation(tsNode)
  for (const ty of unionTypeParts(checker.getApparentType(type))) {
    if (resultProperties.map((p) => ty.getProperty(p)).every((p) => p !== undefined)) return true
  }
  return false
}

/** Extract union type parts (handles non-union types by returning a single-element array). */
function unionTypeParts(type) {
  if (type.isUnion()) return type.types
  return [type]
}

function findMemberName(node) {
  if (!node) return null
  if (node.property.type !== 'Identifier') return null
  return node.property.name
}

function isMemberCalledFn(node) {
  if (node?.parent?.type !== 'CallExpression') return false
  return node.parent.callee === node
}

function isHandledResult(node) {
  const memberExpression = node.parent
  if (memberExpression?.type === 'MemberExpression') {
    const methodName = findMemberName(memberExpression)
    const methodIsCalled = isMemberCalledFn(memberExpression)
    if (methodName && handledMethods.includes(methodName) && methodIsCalled) return true
    const parent = node.parent?.parent
    if (parent && parent?.type !== 'ExpressionStatement') return isHandledResult(parent)
  }
  return false
}

const endTransverse = ['BlockStatement', 'Program']

function getAssignation(checker, parserServices, node) {
  if (
    node.type === 'VariableDeclarator' &&
    isResultLike(checker, parserServices, node.init) &&
    node.id.type === 'Identifier'
  )
    return node.id
  if (endTransverse.includes(node.type) || !node.parent) return
  return getAssignation(checker, parserServices, node.parent)
}

function isReturned(node) {
  if (node.type === 'ArrowFunctionExpression') return true
  if (node.type === 'ReturnStatement') return true
  if (node.type === 'BlockStatement') return false
  if (node.type === 'Program') return false
  if (!node.parent) return false
  return isReturned(node.parent)
}

const ignoreParents = ['ClassDeclaration', 'FunctionDeclaration', 'MethodDefinition', 'ClassProperty']

function processSelector(context, checker, parserServices, node, reportAs = node) {
  if (node.parent?.type.startsWith('TS')) return false
  if (node.parent && ignoreParents.includes(node.parent.type)) return false
  if (!isResultLike(checker, parserServices, node)) return false
  if (isHandledResult(node)) return false
  if (isReturned(node)) return false
  const assignedTo = getAssignation(checker, parserServices, node)
  const currentScope = context.sourceCode.getScope(node)
  if (assignedTo) {
    const references =
      currentScope.set.get(assignedTo.name)?.references.filter((ref) => ref.identifier !== assignedTo) ?? []
    if (references.length > 0) {
      // A Result is handled if ANY reference handles it (e.g. .isErr() guard).
      // The original rule used .some() which reports if ANY reference is unhandled,
      // but accessing .value/.error after a guard is expected — not a violation.
      const anyHandled = references.some((ref) => {
        const refNode = ref.identifier
        if (!isResultLike(checker, parserServices, refNode)) return false
        return isHandledResult(refNode) || isReturned(refNode)
      })
      if (anyHandled) return false
      // No reference handles it — report on the original node
      context.report({ node: reportAs, messageId: 'mustUseResult' })
      return true
    }
  }
  context.report({ node: reportAs, messageId: 'mustUseResult' })
  return true
}

const mustUseResult = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    docs: { description: 'Not handling a neverthrow Result is a possible error because errors could remain unhandled.' },
    messages: { mustUseResult: 'Result must be handled with match, unwrapOr, _unsafeUnwrap, isErr, or isOk.' },
    schema: [],
    type: 'problem',
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context)
    const checker = services.program.getTypeChecker()
    return {
      [resultSelector](node) {
        return processSelector(context, checker, services, node)
      },
    }
  },
})

export const rules = { 'must-use-result': mustUseResult }
export default { rules }

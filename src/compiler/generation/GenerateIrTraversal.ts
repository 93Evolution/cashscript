import {
  ContractNode,
  ParameterNode,
  VariableDefinitionNode,
  FunctionDefinitionNode,
  AssignNode,
  IdentifierNode,
  BranchNode,
  CastNode,
  FunctionCallNode,
  UnaryOpNode,
  BinaryOpNode,
  BoolLiteralNode,
  IntLiteralNode,
  HexLiteralNode,
  StringLiteralNode,
  BlockNode,
  TimeOpNode,
  SizeOpNode,
  SplitOpNode,
  ArrayNode,
  TupleIndexOpNode,
  RequireNode,
} from '../ast/AST';
import AstTraversal from '../ast/AstTraversal';
import {
  PushInt,
  Get,
  PushBool,
  PushString,
  PushBytes,
  Replace,
  IrOp,
  toIrOps,
} from './IR';
import { GlobalFunction } from '../ast/Globals';
import { resultingType, PrimitiveType } from '../ast/Type';
import { Op } from './Script';

export default class GenerateIrTraversal extends AstTraversal {
  output: IrOp[] = [];
  stack: string[] = [];

  private scopeDepth = 0;

  private emit(op: IrOp | IrOp[]) {
    if (Array.isArray(op)) {
      this.output.push(...op);
    } else {
      this.output.push(op);
    }
  }

  private pushToStack(value: string, pushToBottom?: boolean) {
    if (pushToBottom) {
      this.stack.push(value);
    } else {
      this.stack.unshift(value);
    }
  }

  private popFromStack(count: number = 1) {
    for (let i = 0; i < count; i += 1) {
      this.stack.shift();
    }
  }

  private nipFromStack() {
    this.stack.splice(1, 1);
  }

  private getStackIndex(value: string) {
    const index = this.stack.indexOf(value);
    if (index === -1) throw new Error(); // Should not happen
    return index;
  }

  visitContract(node: ContractNode) {
    node.parameters = this.visitList(node.parameters) as ParameterNode[];
    if (node.functions.length === 1) {
      node.functions = this.visitList(node.functions) as FunctionDefinitionNode[];
    } else {
      this.pushToStack('$$', true);
      node.functions = node.functions.map((f, i) => {
        const stackCopy = [...this.stack];
        this.emit(new Get(this.getStackIndex('$$')));
        this.emit(new PushInt(i));
        this.emit(Op.OP_NUMEQUAL);
        this.emit(Op.OP_IF);
        f = this.visit(f) as FunctionDefinitionNode;

        if (i < node.functions.length - 1) {
          this.emit(Op.OP_ELSE);
          this.stack = [...stackCopy];
        }

        return f;
      });

      node.functions.forEach(() => this.emit(Op.OP_ENDIF));
    }

    return node;
  }

  visitFunctionDefinition(node: FunctionDefinitionNode) {
    node.parameters = this.visitList(node.parameters) as ParameterNode[];
    node.body = this.visit(node.body) as BlockNode;
    this.cleanStack();
    return node;
  }

  cleanStack() {
    this.stack.forEach(() => {
      this.emit(Op.OP_DROP);
    });
    this.stack = [];
    this.pushToStack('true');
    this.emit(new PushBool(true));
  }

  visitParameter(node: ParameterNode) {
    this.pushToStack(node.name, true);
    return node;
  }

  visitVariableDefinition(node: VariableDefinitionNode) {
    node.expression = this.visit(node.expression);
    this.popFromStack();
    this.pushToStack(node.name);
    return node;
  }

  visitAssign(node: AssignNode) {
    node.expression = this.visit(node.expression);
    if (this.scopeDepth > 0) {
      this.emit(new Replace(this.getStackIndex(node.identifier.name)));
      this.popFromStack();
    } else {
      this.popFromStack();
      this.pushToStack(node.identifier.name);
    }
    return node;
  }

  visitTimeOp(node: TimeOpNode) {
    node.expression = this.visit(node.expression);
    this.emit(toIrOps.fromTimeOp(node.timeOp));
    this.popFromStack();
    return node;
  }

  visitRequire(node: RequireNode) {
    node.expression = this.visit(node.expression);
    this.emit(Op.OP_VERIFY);
    this.popFromStack();
    return node;
  }

  visitBranch(node: BranchNode) {
    node.condition = this.visit(node.condition);
    this.popFromStack();

    this.scopeDepth += 1;
    this.emit(Op.OP_IF);

    let stackDepth = this.stack.length;
    node.ifBlock = this.visit(node.ifBlock);
    this.removeScopedVariables(stackDepth);

    if (node.elseBlock) {
      this.emit(Op.OP_ELSE);
      stackDepth = this.stack.length;
      node.elseBlock = this.visit(node.elseBlock);
      this.removeScopedVariables(stackDepth);
    }

    this.emit(Op.OP_ENDIF);
    this.scopeDepth -= 1;

    return node;
  }

  removeScopedVariables(depthBeforeScope: number) {
    for (let i = 0; i < this.stack.length - depthBeforeScope; i += 1) {
      this.emit(Op.OP_DROP);
      this.popFromStack();
    }
  }

  visitCast(node: CastNode) {
    node.expression = this.visit(node.expression);
    this.emit(toIrOps.fromCast(node.expression.type as PrimitiveType, node.type));
    this.popFromStack();
    this.pushToStack('(value)');
    return node;
  }

  visitFunctionCall(node: FunctionCallNode) {
    if (node.identifier.name === GlobalFunction.CHECKMULTISIG) {
      return this.visitMultiSig(node);
    }

    node.parameters = this.visitList(node.parameters);
    this.emit(toIrOps.fromFunction(node.identifier.name as GlobalFunction));
    this.popFromStack(node.parameters.length);
    this.pushToStack('(value)');

    return node;
  }

  visitMultiSig(node: FunctionCallNode) {
    this.emit(new PushBool(false));
    node.parameters = this.visitList(node.parameters);
    this.emit(Op.OP_CHECKMULTISIG);
    const sigs = node.parameters[0] as ArrayNode;
    const pks = node.parameters[1] as ArrayNode;
    this.popFromStack(sigs.elements.length + pks.elements.length + 2);
    this.pushToStack('(value)');

    return node;
  }

  visitTupleIndexOp(node: TupleIndexOpNode) {
    node.tuple = this.visit(node.tuple);

    if (node.index === 0) {
      this.emit(Op.OP_DROP);
      this.popFromStack();
    } else if (node.index === 1) {
      this.emit(Op.OP_NIP);
      this.nipFromStack();
    }

    return node;
  }

  visitSizeOp(node: SizeOpNode) {
    node.object = this.visit(node.object);
    this.emit(Op.OP_SIZE);
    this.emit(Op.OP_NIP);
    this.popFromStack();
    this.pushToStack('(value)');
    return node;
  }

  visitSplitOp(node: SplitOpNode) {
    node.object = this.visit(node.object);
    node.index = this.visit(node.index);
    this.emit(Op.OP_SPLIT);
    this.popFromStack(2);
    this.pushToStack('(value)');
    this.pushToStack('(value)');
    return node;
  }

  visitBinaryOp(node: BinaryOpNode) {
    node.left = this.visit(node.left);
    node.right = this.visit(node.right);
    this.emit(toIrOps.fromBinaryOp(
      node.operator,
      resultingType(node.left.type, node.right.type) === PrimitiveType.INT,
    ));
    this.popFromStack(2);
    this.pushToStack('(value)');
    return node;
  }

  visitUnaryOp(node: UnaryOpNode) {
    node.expression = this.visit(node.expression);
    this.emit(toIrOps.fromUnaryOp(node.operator));
    this.popFromStack();
    this.pushToStack('(value)');
    return node;
  }

  visitArray(node: ArrayNode) {
    node.elements = this.visitList(node.elements);
    this.emit(new PushInt(node.elements.length));
    this.pushToStack('(value)');
    return node;
  }

  visitIdentifier(node: IdentifierNode) {
    this.emit(new Get(this.getStackIndex(node.name)));
    this.pushToStack('(value)');
    return node;
  }

  visitBoolLiteral(node: BoolLiteralNode) {
    this.emit(new PushBool(node.value));
    this.pushToStack('(value)');
    return node;
  }

  visitIntLiteral(node: IntLiteralNode) {
    this.emit(new PushInt(node.value));
    this.pushToStack('(value)');
    return node;
  }

  visitStringLiteral(node: StringLiteralNode) {
    this.emit(new PushString(node.value));
    this.pushToStack('(value)');
    return node;
  }

  visitHexLiteral(node: HexLiteralNode) {
    this.emit(new PushBytes(node.value));
    this.pushToStack('(value)');
    return node;
  }
}

import * as fs from 'fs';
import * as path from 'path';
import { ElectronProcess, TestResult } from '../types/index.js';
import { executeCDPCommand } from './cdp-client.js';
import { logger } from '../core/logger.js';

// O diretório de screenshots deve ser gerenciado de forma centralizada.
const SCREENSHOTS_DIR = path.join(process.cwd(), 'electron-screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

/**
 * Captura um snapshot da página, incluindo screenshot, árvore DOM otimizada e elementos interativos.
 * @param electronProcess O processo Electron.
 * @param targetId O ID do alvo.
 * @returns Um objeto contendo o screenshot em base64, a árvore DOM e os elementos interativos.
 */
export async function capturePageSnapshot(electronProcess: ElectronProcess, targetId: string): Promise<any> {
  logger.info(`[DOMInteractor] Capturing page snapshot for target ${targetId}`);
  try {
    // 1. Capturar o screenshot
    const screenshotResult = await executeCDPCommand(electronProcess, targetId, 'Page', 'captureScreenshot', {
      format: 'jpeg', // JPEG é mais eficiente em termos de tamanho
      quality: 80,
    });
    const screenshotBase64 = screenshotResult.data;

    // 2. Obter a árvore DOM completa
    const { root } = await executeCDPCommand(electronProcess, targetId, 'DOM', 'getDocument', {
      depth: -1,
      pierce: true,
    });

    // 3. Otimizar a árvore DOM e extrair elementos interativos
    const simplifiedDomTree = simplifyNode(root);
    const interactiveElements = extractInteractiveElements(root);

    const snapshot = {
      screenshotBase64,
      domTree: simplifiedDomTree,
      interactiveElements,
    };

    logger.info(`[DOMInteractor] Successfully captured page snapshot for target ${targetId}`);
    return snapshot;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[DOMInteractor] Error capturing page snapshot: ${errorMessage}`);
    throw error;
  }
}

// Funções auxiliares para otimização de token

function simplifyNode(node: any): any {
  // Ignorar scripts, estilos, comentários e nós de texto vazios
  if (
    node.nodeName === 'SCRIPT' ||
    node.nodeName === 'STYLE' ||
    node.nodeName === '#comment' ||
    (node.nodeName === '#text' && !node.nodeValue.trim())
  ) {
    return null;
  }

  const simplified: any = {
    tag: node.nodeName.toLowerCase(),
  };

  if (node.nodeValue && node.nodeValue.trim()) {
    simplified.text = node.nodeValue.trim();
  }

  const attributes = formatAttributes(node.attributes);
  const essentialAttributes: { [key: string]: string } = {};
  const essentialAttrKeys = ['id', 'class', 'href', 'src', 'alt', 'placeholder', 'role', 'aria-label', 'name'];
  for (const key of essentialAttrKeys) {
    if (attributes[key]) {
      essentialAttributes[key] = attributes[key];
    }
  }
  if (Object.keys(essentialAttributes).length > 0) {
    simplified.attrs = essentialAttributes;
  }

  if (node.children) {
    simplified.children = node.children
      .map(simplifyNode)
      .filter((child: any) => child !== null);
    if (simplified.children.length === 0) {
      delete simplified.children;
    }
  }

  return simplified;
}

function extractInteractiveElements(node: any, elements: any[] = []): any[] {
    const interactiveTags = ['a', 'button', 'input', 'select', 'textarea'];
    const nodeName = node.nodeName.toLowerCase();

    if (interactiveTags.includes(nodeName)) {
        const attributes = formatAttributes(node.attributes);
        const name = attributes['aria-label'] || attributes['name'] || node.nodeValue || '';
        elements.push({
            role: nodeName,
            name: name.trim(),
            selector: generateCssSelector(node), // Função para gerar um seletor confiável
        });
    }

    if (node.children) {
        for (const child of node.children) {
            extractInteractiveElements(child, elements);
        }
    }
    return elements;
}

function formatAttributes(attributes: string[] = []): { [key: string]: string } {
    const result: { [key: string]: string } = {};
    for (let i = 0; i < attributes.length; i += 2) {
        result[attributes[i]] = attributes[i + 1];
    }
    return result;
}

function generateCssSelector(node: any): string {
    if (node.attributes) {
        const attrs = formatAttributes(node.attributes);
        if (attrs.id) {
            return `#${attrs.id}`;
        }
    }
    // Fallback para um seletor de tag - uma implementação mais robusta geraria um caminho completo.
    return node.nodeName.toLowerCase();
}

/**
 * @deprecated Use executeScript instead.
 * Avalia uma expressão JavaScript em um alvo com opções avançadas.
 * @param electronProcess O processo Electron.
 * @param targetId O ID do alvo.
 * @param expression A expressão a ser avaliada.
 * @param options Opções para a avaliação.
 * @returns Um objeto TestResult com os resultados da avaliação.
 */
export async function evaluateJavaScriptAdvanced(
  electronProcess: ElectronProcess, 
  targetId: string, 
  expression: string, 
  options: {
    returnByValue?: boolean;
    awaitPromise?: boolean;
    timeout?: number;
    captureConsole?: boolean;
    takeScreenshot?: boolean;
  } = {}
): Promise<TestResult> {
  const startTime = Date.now();
  const result: TestResult = {
    success: false,
    action: 'evaluate_javascript_advanced',
    details: {},
    timing: { startTime, endTime: 0, duration: 0 }
  };

  try {
    if (options.captureConsole) {
      await executeCDPCommand(electronProcess, targetId, 'Console', 'enable');
    }
    if (options.takeScreenshot) {
      const screenshotResult = await executeCDPCommand(electronProcess, targetId, 'Page', 'captureScreenshot', { format: 'png' });
      result.screenshot = screenshotResult.data;
    }

    const evalResult = await executeCDPCommand(electronProcess, targetId, 'Runtime', 'evaluate', {
      expression,
      returnByValue: options.returnByValue !== false,
      awaitPromise: options.awaitPromise || false,
      timeout: options.timeout || 5000,
    });

    result.details = evalResult;
    result.success = !evalResult.exceptionDetails;

    if (options.takeScreenshot) {
        const screenshotResultAfter = await executeCDPCommand(electronProcess, targetId, 'Page', 'captureScreenshot', { format: 'png' });
        result.screenshot = screenshotResultAfter.data;
    }
    
  } catch (error) {
    result.success = false;
    result.details = { error: error instanceof Error ? error.message : String(error) };
  }

  const endTime = Date.now();
  result.timing.endTime = endTime;
  result.timing.duration = endTime - startTime;
  return result;
}

/**
 * @deprecated Use interactWithDom({ action: 'click', ... }) instead.
 * Simula um clique em um elemento do DOM.
 * @param electronProcess O processo Electron.
 * @param targetId O ID do alvo.
 * @param selector O seletor CSS do elemento.
 * @param options Opções para o clique.
 * @returns Um objeto TestResult com os resultados do clique.
 */
export async function simulateClick(
  electronProcess: ElectronProcess, 
  targetId: string, 
  selector: string,
  options: {
    verifyElement?: boolean;
    waitAfterClick?: number;
  } = {}
): Promise<TestResult> {
    const startTime = Date.now();
    const result: TestResult = {
        success: false,
        action: 'simulate_click',
        details: { selector },
        timing: { startTime, endTime: 0, duration: 0 }
    };

    try {
        const clickExpression = `
            (function() {
                const element = document.querySelector('${selector}');
                if (!element) return { success: false, error: 'Element not found' };
                element.click();
                return { success: true };
            })();
        `;
        const clickResult = await executeScript(electronProcess, targetId, clickExpression, { awaitPromise: true });

        result.success = clickResult.success;
        result.details.clickResult = clickResult.details;

        if (options.waitAfterClick) {
            await new Promise(resolve => setTimeout(resolve, options.waitAfterClick));
        }

    } catch (error) {
        result.success = false;
        result.details.error = error instanceof Error ? error.message : String(error);
    }

    const endTime = Date.now();
    result.timing.endTime = endTime;
    result.timing.duration = endTime - startTime;
    return result;
}

/**
 * @deprecated Use inspectDom({ query: 'verify_state', ... }) instead.
 * Verifica o estado de elementos no DOM.
 * @param electronProcess O processo Electron.
 * @param targetId O ID do alvo.
 * @param checks Uma lista de verificações a serem executadas.
 * @returns Um objeto TestResult com os resultados das verificações.
 */
export async function verifyDOMState(
  electronProcess: ElectronProcess, 
  targetId: string, 
  checks: Array<{
    selector: string;
    property?: string;
    expectedValue?: any;
    exists?: boolean;
  }>
): Promise<TestResult> {
    const startTime = Date.now();
    const result: TestResult = {
        success: true,
        action: 'verify_dom_state',
        details: { checks: [] },
        timing: { startTime, endTime: 0, duration: 0 }
    };

    try {
        for (const check of checks) {
            const checkExpression = `
                (function() {
                    const element = document.querySelector('${check.selector}');
                    if (!element) return { exists: false, success: ${check.exists === false} };
                    
                    const result = { exists: true, success: true };
                    ${check.property ? `result.propertyValue = element.${check.property};` : ''}
                    
                    if (${check.exists !== undefined} && result.exists !== ${check.exists}) {
                        result.success = false;
                    }
                    if (${check.property && check.expectedValue !== undefined} && result.propertyValue !== ${JSON.stringify(check.expectedValue)}) {
                        result.success = false;
                    }
                    return result;
                })();
            `;
            const checkResult = await executeScript(electronProcess, targetId, checkExpression, { returnByValue: true });
            
            (result.details.checks as any[]).push({ selector: check.selector, ...checkResult.details });
            if (!checkResult.success) {
                result.success = false;
            }
        }
    } catch (error) {
        result.success = false;
        result.details.error = error instanceof Error ? error.message : String(error);
    }

    const endTime = Date.now();
    result.timing.endTime = endTime;
    result.timing.duration = endTime - startTime;
    return result;
}

/**
 * @deprecated Use inspectDom({ query: 'get_tree', ... }) instead.
 * Inspeciona e retorna a árvore DOM completa da janela em formato JSON.
 * @param electronProcess O processo Electron.
 * @param targetId O ID do alvo.
 * @returns Uma promessa que resolve com a árvore DOM em formato de objeto.
 */
export async function getDOMTree(electronProcess: ElectronProcess, targetId: string): Promise<any> {
  logger.info(`[DOMInteractor] Getting DOM tree for target ${targetId}`);
  try {
    // Primeiro, obtemos o nó raiz do documento.
    const { root } = await executeCDPCommand(electronProcess, targetId, 'DOM', 'getDocument', {
      depth: -1, // -1 para a árvore inteira
      pierce: true // para obter conteúdo de shadow DOM
    });

    // A partir do nó raiz, podemos obter o HTML completo ou a estrutura.
    // Para um JSON, podemos construir a árvore recursivamente ou usar getOuterHTML.
    // getOuterHTML é mais simples para uma representação completa.
    const { outerHTML } = await executeCDPCommand(electronProcess, targetId, 'DOM', 'getOuterHTML', {
        nodeId: root.nodeId
    });

    // Para retornar um JSON "real", precisaríamos de uma biblioteca de parsing de HTML no servidor,
    // o que adicionaria uma dependência pesada. Retornar o HTML é mais prático.
    // O cliente pode então decidir como processá-lo.
    // No entanto, a tarefa pede JSON. Vamos construir um objeto simples.
    // Nota: Uma implementação mais robusta usaria uma função recursiva para construir a árvore.
    
    // Função auxiliar para converter atributos para um formato mais amigável
    const formatAttributes = (attributes: string[] = []) => {
        const result: { [key: string]: string } = {};
        for (let i = 0; i < attributes.length; i += 2) {
            result[attributes[i]] = attributes[i + 1];
        }
        return result;
    };

    // Função recursiva para construir a árvore JSON
    const buildNodeTree = (node: any): any => {
        const jsonNode: any = {
            nodeName: node.nodeName,
            nodeType: node.nodeType,
            nodeValue: node.nodeValue,
            attributes: formatAttributes(node.attributes),
            children: []
        };
        if (node.children) {
            for (const child of node.children) {
                jsonNode.children.push(buildNodeTree(child));
            }
        }
        return jsonNode;
    };
    
    const jsonTree = buildNodeTree(root);

    logger.info(`[DOMInteractor] Successfully retrieved DOM tree for target ${targetId}`);
    return jsonTree;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[DOMInteractor] Error getting DOM tree: ${errorMessage}`);
    throw error;
  }
}

/**
 * @deprecated Use interactWithDom({ action: 'double_click', ... }) instead.
 * Simula um clique duplo em um elemento do DOM.
 * @param electronProcess O processo Electron.
 * @param targetId O ID do alvo.
 * @param selector O seletor CSS do elemento.
 * @returns Um objeto TestResult com os resultados da ação.
 */
export async function simulateDoubleClick(electronProcess: ElectronProcess, targetId: string, selector: string): Promise<TestResult> {
    const jsExpression = `
        const element = document.querySelector('${selector}');
        if (!element) throw new Error('Element not found');
        const { x, y, width, height } = element.getBoundingClientRect();
        if (width === 0 || height === 0) throw new Error('Element has no size');
        // Retorna o centro do elemento
        JSON.stringify({ x: x + width / 2, y: y + height / 2 });
    `;
    const evalResult = await executeScript(electronProcess, targetId, jsExpression);
    if (!evalResult.success || !evalResult.details.result.value) {
        throw new Error(`Could not find element or its coordinates for selector: ${selector}`);
    }
    const { x, y } = JSON.parse(evalResult.details.result.value);

    await executeCDPCommand(electronProcess, targetId, 'Input', 'dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 2,
    });
    await executeCDPCommand(electronProcess, targetId, 'Input', 'dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 2,
    });

    return {
        success: true,
        action: 'simulate_double_click',
        details: { selector, x, y },
        timing: { startTime: 0, endTime: 0, duration: 0 } // Simplificado
    };
}

/**
 * @deprecated Use interactWithDom({ action: 'hover', ... }) instead.
 * Simula um hover sobre um elemento do DOM.
 * @param electronProcess O processo Electron.
 * @param targetId O ID do alvo.
 * @param selector O seletor CSS do elemento.
 * @returns Um objeto TestResult com os resultados da ação.
 */
export async function simulateHover(electronProcess: ElectronProcess, targetId: string, selector: string): Promise<TestResult> {
    const jsExpression = `
        const element = document.querySelector('${selector}');
        if (!element) throw new Error('Element not found');
        const { x, y, width, height } = element.getBoundingClientRect();
        if (width === 0 || height === 0) throw new Error('Element has no size');
        JSON.stringify({ x: x + width / 2, y: y + height / 2 });
    `;
    const evalResult = await executeScript(electronProcess, targetId, jsExpression);
    if (!evalResult.success || !evalResult.details.result.value) {
        throw new Error(`Could not find element for hover: ${selector}`);
    }
    const { x, y } = JSON.parse(evalResult.details.result.value);

    await executeCDPCommand(electronProcess, targetId, 'Input', 'dispatchMouseEvent', {
        type: 'mouseMoved', x, y
    });
    
    return {
        success: true,
        action: 'simulate_hover',
        details: { selector, x, y },
        timing: { startTime: 0, endTime: 0, duration: 0 }
    };
}

/**
 * @deprecated Use interactWithDom({ action: 'submit', ... }) instead.
 * Submete um formulário do DOM.
 * @param electronProcess O processo Electron.
 * @param targetId O ID do alvo.
 * @param selector O seletor CSS do formulário.
 * @returns Um objeto TestResult com os resultados da ação.
 */
export async function submitForm(electronProcess: ElectronProcess, targetId: string, selector: string): Promise<TestResult> {
    const expression = `
        const form = document.querySelector('${selector}');
        if (form && form instanceof HTMLFormElement) {
            form.submit();
            return { success: true };
        }
        return { success: false, error: 'Form element not found' };
    `;
    return executeScript(electronProcess, targetId, expression, { awaitPromise: true });
}

/**
 * @deprecated Use interactWithDom({ action: 'set_attribute', ... }) instead.
 * Modifica um atributo de um elemento do DOM.
 * @param electronProcess O processo Electron.
 * @param targetId O ID do alvo.
 * @param selector O seletor CSS do elemento.
 * @param attribute O nome do atributo a ser modificado.
 * @param value O novo valor para o atributo.
 * @returns Um objeto TestResult com os resultados da ação.
 */
export async function setElementAttribute(
    electronProcess: ElectronProcess,
    targetId: string,
    selector: string,
    attribute: string,
    value: string
): Promise<TestResult> {
    const expression = `
        const element = document.querySelector('${selector}');
        if (element) {
            element.setAttribute('${attribute}', '${value}');
            return { success: true };
        }
        return { success: false, error: 'Element not found' };
    `;
    return executeScript(electronProcess, targetId, expression);
}

/**
 * Executa uma expressão JavaScript em um alvo com opções avançadas.
 * @param electronProcess O processo Electron.
 * @param targetId O ID do alvo.
 * @param expression A expressão a ser avaliada.
 * @param options Opções para a avaliação.
 * @returns Um objeto TestResult com os resultados da avaliação.
 */
export async function executeScript(
  electronProcess: ElectronProcess,
  targetId: string,
  expression: string,
  options: {
    returnByValue?: boolean;
    awaitPromise?: boolean;
    timeout?: number;
    captureConsole?: boolean;
    takeScreenshot?: boolean;
  } = {}
): Promise<TestResult> {
    return evaluateJavaScriptAdvanced(electronProcess, targetId, expression, options);
}

/**
 * Interage com o DOM de várias maneiras.
 * @param params Parâmetros para a interação.
 * @returns O resultado da interação.
 */
export async function interactWithDom(params: {
  electronProcess: ElectronProcess;
  targetId: string;
  selector: string;
  action: 'click' | 'double_click' | 'hover' | 'submit' | 'set_attribute' | 'type_text';
  value?: string;
  attribute?: string;
}): Promise<TestResult> {
  const { electronProcess, targetId, selector, action, value, attribute } = params;

  switch (action) {
    case 'click':
      return simulateClick(electronProcess, targetId, selector);
    case 'double_click':
      return simulateDoubleClick(electronProcess, targetId, selector);
    case 'hover':
      return simulateHover(electronProcess, targetId, selector);
    case 'submit':
      return submitForm(electronProcess, targetId, selector);
    case 'set_attribute':
      if (!attribute || value === undefined) throw new Error('attribute and value are required for set_attribute action.');
      return setElementAttribute(electronProcess, targetId, selector, attribute, value);
    case 'type_text':
       if (value === undefined) throw new Error('value is required for type_text action.');
       // A lógica para 'type_text' seria implementada aqui, provavelmente usando executeScript.
       const expression = `
         (() => {
           const element = document.querySelector('${selector}');
           if (element) {
               element.value = '${value}';
               return { success: true };
           }
           return { success: false, error: 'Element not found' };
         })();
       `;
       return executeScript(electronProcess, targetId, expression, { returnByValue: true });
    default:
      throw new Error(`Invalid DOM interaction action: ${action}`);
  }
}

/**
 * Inspeciona o DOM.
 * @param params Parâmetros para a inspeção.
 * @returns O resultado da inspeção.
 */
export async function inspectDom(params: {
  electronProcess: ElectronProcess;
  targetId: string;
  query: 'get_tree' | 'verify_state';
  checks?: Array<{
    selector: string;
    property?: string;
    expectedValue?: any;
    exists?: boolean;
  }>;
}): Promise<any> {
  const { electronProcess, targetId, query, checks } = params;

  switch (query) {
    case 'get_tree':
      return getDOMTree(electronProcess, targetId);
    case 'verify_state':
      if (!checks) throw new Error('checks are required for verify_state query.');
      return verifyDOMState(electronProcess, targetId, checks);
    default:
      throw new Error(`Invalid DOM inspection query: ${query}`);
  }
}
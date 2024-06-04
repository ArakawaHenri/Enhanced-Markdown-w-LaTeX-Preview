import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

const config = vscode.workspace.getConfiguration('enhanced-md-tex-preview', null);
const pathRegex = /^[a-zA-Z0-9_\-\/\\:\s.()]+$/;
const pandocPath = normalizePath(config.get('pandocPath'), "pandoc");

const incrementalCompileEnabled = config.get('incrementalCompile') as boolean;
let latexTemplate = getTemplates(config.get('latexTemplate'));
let htmlTemplate = getTemplates(config.get('htmlTemplate'));

const highlightStyle = normalizeString(config.get('highlightStyle'), "tango");
const mathEngine = normalizeString(config.get('mathEngine'), "mathml");

let panelToFileMap = new Map<vscode.WebviewPanel, string>();

function normalizePath(rawPath: string | null | undefined, defaultValue: string): string {
    return (rawPath !== "" && rawPath !== defaultValue && rawPath !== null && rawPath !== undefined)
        ? `'${path.normalize(rawPath)}'`
        : defaultValue;
}

function getTemplates(templateConfig: string | null | undefined): string[] | null {
    return (templateConfig !== "" && templateConfig !== null && templateConfig !== undefined)
        ? templateConfig.split(",").map(template => template.trim()).filter(template => template !== "").filter(template => pathRegex.test(template)).map(template => path.normalize(template))
        : null;
}

function normalizeString(rawString: string | null | undefined, defaultValue: string): string {
    return (rawString === "" || rawString === null || rawString === undefined) ? defaultValue : rawString;
}

function debounce<T extends (...args: any[]) => void>(func: T, wait: number): (...args: Parameters<T>) => void {
    let timeout: NodeJS.Timeout | undefined;
    return (...args: Parameters<T>) => {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

export function activate(context: vscode.ExtensionContext) {
    const statusBarLatexTemplate = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarLatexTemplate.command = 'enhanced-md-tex-preview.setLatexTemplatePath';
    statusBarLatexTemplate.tooltip = "Set LaTeX Template Path";

    const statusBarHtmlTemplate = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarHtmlTemplate.command = 'enhanced-md-tex-preview.setHtmlTemplatePath';
    statusBarHtmlTemplate.tooltip = "Set HTML Template Path";

    function updateStatusBarLatexItem() {
        updateStatusBarTemplateItem(statusBarLatexTemplate, latexTemplate, "LaTeX");
    }

    function updateStatusBarHtmlItem() {
        updateStatusBarTemplateItem(statusBarHtmlTemplate, htmlTemplate, "HTML");
    }

    function updateStatusBarTemplateItem(statusBarItem: vscode.StatusBarItem, template: string[] | null, type: string) {
        statusBarItem.text = `${type} Template: ` + ((fullPath) => {
            if (!fullPath) return 'Default';

            fullPath = fullPath.replace(/^['"]|['"]$/g, '').replace(/\\\\/g, '\\');
            const dirPath = path.dirname(fullPath);
            const fileName = path.basename(fullPath);
            const lastDirName = path.basename(dirPath);
            const levels = fullPath.split(/[/\\]/).filter(level => level !== '');
            let result;
            if (levels.length <= 2) {
                result = fullPath;
            } else {
                const lastTwoLevels = path.join(lastDirName, fileName);
                result = '...' + lastTwoLevels;
            }
            return `"${result}"`;
        })(template ? template[0] : null) + ((template && template.length > 1) ? "..." + `\[+${template.length - 1}\]` : "");
    }

    async function updateTemplateSettings(type: 'latex' | 'html', action: string) {
        const activeEditor = vscode.window.activeTextEditor;
        const templateConfigKey = type === 'latex' ? 'latexTemplate' : 'htmlTemplate';
        let paths = null;
        if (action.includes('Select New')) {
            const options: vscode.OpenDialogOptions = {
                canSelectMany: true,
                openLabel: `Select ${type === 'latex' ? 'LaTeX' : 'HTML'} Templates`,
                filters: { [`${type === 'latex' ? 'LaTeX' : 'HTML'} files`]: [type === 'latex' ? 'tex' : 'html', 'htm'] }
            };
            const fileUris = await vscode.window.showOpenDialog(options);
            if (fileUris && fileUris.length > 0) {
                paths = fileUris.map(uri => uri.fsPath);
                await config.update(templateConfigKey, paths.join(','), vscode.ConfigurationTarget.Workspace);
                type === 'latex' ? latexTemplate = paths : htmlTemplate = paths;
            }
        } else if (action === 'Use Default Template') {
            await config.update(templateConfigKey, '', vscode.ConfigurationTarget.Workspace);
            type === 'latex' ? latexTemplate = null : htmlTemplate = null;
        } else if (action === 'Clear Workspace Settings') {
            await config.update(templateConfigKey, undefined, vscode.ConfigurationTarget.Workspace);
            type === 'latex' ? latexTemplate = getTemplates(config.get('latexTemplate')) : htmlTemplate = getTemplates(config.get('htmlTemplate'));
        }
        type === 'latex' ? updateStatusBarLatexItem() : updateStatusBarHtmlItem();
        if (activeEditor) {
            panelToFileMap.forEach((file, panel) => {
                if (file === activeEditor.document.fileName) {
                    updatePreview(activeEditor, panel, vscode.workspace.rootPath || '');
                }
            });
        }
    }

    updateStatusBarLatexItem();
    updateStatusBarHtmlItem();

    context.subscriptions.push(statusBarLatexTemplate, statusBarHtmlTemplate);

    function updateVisibility() {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'markdown') {
            statusBarLatexTemplate.show();
            statusBarHtmlTemplate.show();
        } else {
            statusBarLatexTemplate.hide();
            statusBarHtmlTemplate.hide();
        }
    }

    context.subscriptions.push(vscode.commands.registerCommand('enhanced-md-tex-preview.setLatexTemplatePath', async () => {
        const pick = await vscode.window.showQuickPick(['Select New LaTeX Template Files', 'Use Default Template', 'Clear Workspace Settings'], {
            placeHolder: 'Choose an action'
        });
        if (pick) updateTemplateSettings('latex', pick);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('enhanced-md-tex-preview.setHtmlTemplatePath', async () => {
        const pick = await vscode.window.showQuickPick(['Select New HTML Template Files', 'Use Default Template', 'Clear Workspace Settings'], {
            placeHolder: 'Choose an action'
        });
        if (pick) updateTemplateSettings('html', pick);
    }));

    updateVisibility();
    vscode.window.onDidChangeActiveTextEditor(updateVisibility, null, context.subscriptions);
    vscode.workspace.onDidOpenTextDocument(updateVisibility, null, context.subscriptions);

    let disposable = vscode.commands.registerCommand('enhanced-md-tex-preview.showPreview', () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.languageId === 'markdown') {
            const panel = vscode.window.createWebviewPanel(
                'markdownPreview',
                'Markdown Preview',
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    localResourceRoots: [vscode.Uri.file(context.extensionPath)]
                }
            );

            panelToFileMap.set(panel, activeEditor.document.fileName);

            let previousContent = '';

            updatePreview(activeEditor, panel, context.extensionPath);
            scrollToCurrentPosition(activeEditor, panel);

            const debouncedUpdatePreview = debounce((activeEditor: vscode.TextEditor, panel: vscode.WebviewPanel, extensionPath: string) => {
                const currentContent = activeEditor.document.getText();
                const { updatedBlocks, needsFullUpdate } = getUpdatedBlocks(previousContent, currentContent);
                previousContent = currentContent;

                if (needsFullUpdate) {
                    updatePreview(activeEditor, panel, extensionPath);
                } else {
                    updatePreviewIncremental(activeEditor, panel, extensionPath, updatedBlocks);
                }
            }, 500);

            panel.webview.onDidReceiveMessage((message) => {
                if (message.command === 'updateComplete') {
                    scrollToCurrentPosition(activeEditor, panel);
                } else if (message.command === 'scrollToPosition') {
                    const { blockIndex, lineInBlock } = message;
                    const markdownContent = addBlockNumbersToMarkdown(activeEditor.document.getText());
                    const { lineNumber } = getBlockInfo(markdownContent, activeEditor.document.lineAt(blockIndex).lineNumber);
                    const scrollPosition = activeEditor.document.offsetAt(new vscode.Position(lineNumber - 1 + lineInBlock, 0));
                    activeEditor.revealRange(new vscode.Range(activeEditor.document.positionAt(scrollPosition), activeEditor.document.positionAt(scrollPosition)));
                }
            });

            panel.onDidChangeViewState(e => {
                if (e.webviewPanel.visible) {
                    const activeEditor = vscode.window.activeTextEditor;
                    if (activeEditor && panelToFileMap.get(panel) === activeEditor.document.fileName) {
                        scrollToCurrentPosition(activeEditor, panel);
                    }
                }
            });

            panel.onDidDispose(() => {
                panelToFileMap.delete(panel);
            });

            const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(event => {
                if (activeEditor && event.document === activeEditor.document) {
                    debouncedUpdatePreview(activeEditor, panel, context.extensionPath);
                }
            }, null, context.subscriptions);

            const onDidScroll = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
                if (event.textEditor === activeEditor && panelToFileMap.get(panel) === activeEditor.document.fileName) {
                    scrollToCurrentPosition(activeEditor, panel);
                }
            });

            context.subscriptions.push(changeDocumentSubscription, onDidScroll);
        }
    });

    context.subscriptions.push(disposable);

    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && editor.document.languageId === 'markdown') {
            const fileName = editor.document.fileName;
            panelToFileMap.forEach((file, panel) => {
                if (file === fileName) {
                    scrollToCurrentPosition(editor, panel);
                }
            });
            registerScrollListener(editor);
        }
    });

    function registerScrollListener(editor: vscode.TextEditor) {
        const onDidScroll = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
            if (event.textEditor === editor) {
                panelToFileMap.forEach((file, panel) => {
                    if (file === editor.document.fileName) {
                        scrollToCurrentPosition(editor, panel);
                    }
                });
            }
        });
        context.subscriptions.push(onDidScroll);
    }

    if (vscode.window.activeTextEditor) {
        registerScrollListener(vscode.window.activeTextEditor);
    }
}

function getUpdatedBlocks(previousContent: string, currentContent: string): { updatedBlocks: number[]; needsFullUpdate: boolean } {
    if (!incrementalCompileEnabled) {
        return { updatedBlocks: [], needsFullUpdate: true };
    }
    const previousBlocks = previousContent.split(/(?=^&%&BLOCK_INDEX_\d+&%&$)/m);
    const currentBlocks = currentContent.split(/(?=^&%&BLOCK_INDEX_\d+&%&$)/m);

    const updatedBlocks: number[] = [];
    let needsFullUpdate = false;
    let lastBlockIndex = -1;

    let i = 0;
    for (; i < Math.min(previousBlocks.length, currentBlocks.length); i++) {
        const previousBlock = previousBlocks[i];
        const currentBlock = currentBlocks[i];

        const previousBlockMatch = previousBlock.match(/^&%&BLOCK_INDEX_(\d+)&%&$/m);
        const currentBlockMatch = currentBlock.match(/^&%&BLOCK_INDEX_(\d+)&%&$/m);

        if (previousBlockMatch && currentBlockMatch) {
            const currentBlockIndex = parseInt(currentBlockMatch[1], 10);

            if (previousBlock !== currentBlock) {
                if (isLatexCommandChanged(previousBlock, currentBlock)) {
                    needsFullUpdate = true;
                    break;
                }
                updatedBlocks.push(currentBlockIndex);
            }
            lastBlockIndex = currentBlockIndex;
        } else {
            needsFullUpdate = true;
            break;
        }
    }

    if (!needsFullUpdate) {
        for (; i < currentBlocks.length; i++) {
            const match = currentBlocks[i].match(/^&%&BLOCK_INDEX_(\d+)&%&$/m);
            if (match) {
                const blockIndex = parseInt(match[1], 10);
                updatedBlocks.push(blockIndex);
                lastBlockIndex = blockIndex;
            } else {
                needsFullUpdate = true;
                break;
            }
        }
    }

    if (!needsFullUpdate && updatedBlocks.length > 0 && lastBlockIndex >= 0) {
        return { updatedBlocks: updatedBlocks.filter(blockIndex => blockIndex >= lastBlockIndex), needsFullUpdate: false };
    }

    if (previousContent.includes("---") && currentContent.includes("---")) {
        const previousYaml = previousContent.split("---")[1];
        const currentYaml = currentContent.split("---")[1];
        if (previousYaml !== currentYaml) {
            needsFullUpdate = true;
        }
    }

    return { updatedBlocks, needsFullUpdate };
}

function isLatexCommandChanged(previousBlock: string, currentBlock: string): boolean {
    const latexCommandRegex = /\\[a-zA-Z]+\{[^}]*\}/g;
    const previousCommands = previousBlock.match(latexCommandRegex) || [];
    const currentCommands = currentBlock.match(latexCommandRegex) || [];
    return JSON.stringify(previousCommands) !== JSON.stringify(currentCommands);
}

function updatePreview(activeEditor: vscode.TextEditor, panel: vscode.WebviewPanel, extensionPath: string) {
    let disposed = false;

    panel.onDidDispose(() => {
        disposed = true;
        panelToFileMap.delete(panel);
    });

    if (panel.visible) {
        const markdownContent = addBlockNumbersToMarkdown(activeEditor.document.getText());

        convertMarkdownToTex(markdownContent)
            .then((texContent) => {
                const replacedTexContent = replaceEnumerateWithNumbers(texContent);
                return convertTexToHtml(replacedTexContent, extensionPath);
            })
            .then((htmlContent) => {
                if (!disposed) {
                    panel.webview.html = getWebviewContent(htmlContent);
                }
            })
            .catch((error) => {
                vscode.window.showErrorMessage('Failed to convert Markdown to HTML: ' + error);
            });
    } else {
        panel.reveal(vscode.ViewColumn.Beside, true);
    }
}

function updatePreviewIncremental(activeEditor: vscode.TextEditor, panel: vscode.WebviewPanel, extensionPath: string, updatedBlocks: number[]) {
    let disposed = false;

    panel.onDidDispose(() => {
        disposed = true;
        panelToFileMap.delete(panel);
    });

    if (panel.visible) {
        const markdownContent = addBlockNumbersToMarkdown(activeEditor.document.getText());

        convertMarkdownBlocksToTex(markdownContent, updatedBlocks)
            .then((texContent) => {
                const replacedTexContent = replaceEnumerateWithNumbers(texContent);
                return convertTexToHtml(replacedTexContent, extensionPath);
            })
            .then((htmlContent) => {
                const blocks = htmlContent.split(/(?=<div data-block-index="\d+"><\/div>)/);
                const updatedHtmlBlocks: { index: number; html: string }[] = [];

                for (const blockIndex of updatedBlocks) {
                    const blockHtml = blocks[blockIndex];
                    if (blockHtml) {
                        updatedHtmlBlocks.push({ index: blockIndex, html: blockHtml });
                    }
                }

                if (!disposed) {
                    panel.webview.postMessage({ command: 'updateBlocks', blocks: updatedHtmlBlocks });
                }
            })
            .catch((error) => {
                vscode.window.showErrorMessage('Failed to convert Markdown to HTML: ' + error);
            });
    } else {
        panel.reveal(vscode.ViewColumn.Beside, true);
    }
}

function convertMarkdownToTex(markdown: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const md2texArgs = ['-f', 'markdown', '-t', 'latex', '--listings'];
        if (latexTemplate && latexTemplate.length > 0) {
            for (const template of latexTemplate) {
                md2texArgs.push('--template=' + template);
            }
        }
        const pandocToLatex = cp.spawn(pandocPath, md2texArgs);
        let texContent = '';
        let errorMessage = '';

        pandocToLatex.stdout.on('data', (data) => {
            texContent += data.toString();
        });

        pandocToLatex.stderr.on('data', (data) => {
            errorMessage += data.toString();
        });

        pandocToLatex.on('close', (code) => {
            if (code !== 0) {
                reject(`Pandoc (markdown to latex) exited with code ${code}: ${errorMessage}`);
            } else {
                resolve(texContent);
            }
        });

        pandocToLatex.stdin.write(markdown);
        pandocToLatex.stdin.end();
    });
}

function convertMarkdownBlocksToTex(markdown: string, updatedBlocks: number[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const md2texArgs = ['-f', 'markdown', '-t', 'latex', '--listings'];
        if (latexTemplate && latexTemplate.length > 0) {
            for (const template of latexTemplate) {
                md2texArgs.push('--template=' + template);
            }
        }
        const pandocToLatex = cp.spawn(pandocPath, md2texArgs);
        let texContent = '';
        let errorMessage = '';

        pandocToLatex.stdout.on('data', (data) => {
            texContent += data.toString();
        });

        pandocToLatex.stderr.on('data', (data) => {
            errorMessage += data.toString();
        });

        pandocToLatex.on('close', (code) => {
            if (code !== 0) {
                reject(`Pandoc (markdown to latex) exited with code ${code}: ${errorMessage}`);
            } else {
                resolve(texContent);
            }
        });

        const blocks = markdown.split(/(?=^&%&BLOCK_INDEX_\d+&%&$)/m);
        const updatedTexBlocks = updatedBlocks.map(index => blocks[index]).join('\n');
        pandocToLatex.stdin.write(updatedTexBlocks);
        pandocToLatex.stdin.end();
    });
}

function convertTexToHtml(tex: string, basePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const tex2htmlArgs = ['-f', 'latex', '-t', 'html', '--' + mathEngine, '--highlight-style=' + highlightStyle];
        if (htmlTemplate && htmlTemplate.length > 0) {
            for (const template of htmlTemplate) {
                tex2htmlArgs.push('--template=' + template);
            }
        }
        const pandocToHtml = cp.spawn(pandocPath, tex2htmlArgs);
        let htmlContent = '';
        let errorMessage = '';

        pandocToHtml.stdout.on('data', (data) => {
            htmlContent += data.toString();
        });

        pandocToHtml.stderr.on('data', (data) => {
            errorMessage += data.toString();
        });

        pandocToHtml.on('close', (code) => {
            if (code !== 0) {
                reject(`Pandoc (latex to html) exited with code ${code}: ${errorMessage}`);
            } else {
                resolve(htmlContent);
            }
        });

        pandocToHtml.stdin.write(tex);
        pandocToHtml.stdin.end();
    });
}

function replaceEnumerateWithNumbers(texContent: string): string {
    const regex = /\\begin\{enumerate\}\s*\\def\\labelenumi\{\\arabic\{enumi\}\.\}(?:\s*\\setcounter\{enumi\}\{(\d+)\})?\s*(?:\\tightlist\s*)?(\\item\s*[\s\S]*?)\\end\{enumerate\}/g;

    return texContent.replace(regex, (match, startNum, items) => {
        let currentNumber = startNum ? parseInt(startNum) + 1 : 1;
        const itemRegex = /^ *(\\item\s+(.*))$/gm;

        const formattedContent = [];
        let itemMatch;
        while ((itemMatch = itemRegex.exec(items)) !== null) {
            const itemText = itemMatch[2];
            formattedContent.push(`\\begingroup\n\\setlength{\\parindent}{2em}\n\\indent{} ${currentNumber}. ${itemText.trim()}\n\\endgroup\n`);
            currentNumber++;
        }

        return formattedContent.join('\n');
    });
}

function addBlockNumbersToMarkdown(markdown: string): string {
    const lines = markdown.split('\n');
    let blockIndex = 0;
    let isCodeBlock = false;
    let isYamlBlock = false;
    let isLatexBlock = false;
    let yamlStarted = false;
    let lastLineWasEmpty = true;
    let yamlEnded = false;
    let latexCommand = '';

    const blockMarkdown = lines.map((line, index) => {
        if (line.trim() === '---') {
            if (!yamlStarted && !isCodeBlock && !isLatexBlock) {
                yamlStarted = true;
                isYamlBlock = true;
                return line;
            } else if (yamlStarted && isYamlBlock) {
                isYamlBlock = false;
                yamlEnded = true;
                return line;
            }
        }

        if (isYamlBlock || (yamlStarted && !yamlEnded)) {
            return line;
        }

        if (line.trim().startsWith('```')) {
            isCodeBlock = !isCodeBlock;
        }

        if (line.trim().startsWith('$$')) {
            isLatexBlock = !isLatexBlock;
        }

        const latexBeginMatch = line.match(/\\begin\{([^}]+)\}/);
        if (latexBeginMatch) {
            latexCommand = latexBeginMatch[1];
        }

        const latexEndMatch = line.match(/\\end\{([^}]+)\}/);
        if (latexEndMatch && latexEndMatch[1] === latexCommand) {
            latexCommand = '';
        }

        if (!isCodeBlock && !isYamlBlock && !isLatexBlock && latexCommand === '' &&
            (line.trim() === '' || line.trim().startsWith('#') || line.trim().startsWith('- ') ||
                line.trim().startsWith('1. ') || line.trim().startsWith('\\[') || line.trim().startsWith('\\begin{'))) {
            if (!lastLineWasEmpty) {
                lastLineWasEmpty = true;
                return `\n&%&BLOCK_INDEX_${blockIndex++}&%&\n${line}`;
            }
        } else {
            if (line.trim() !== '') {
                lastLineWasEmpty = false;
            }
        }

        return line;
    }).join('\n');

    return blockMarkdown;
}

function getBlockInfo(content: string, line: number): { blockIndex: number; lineNumber: number } {
    const lines = content.split('\n');

    let blockIndex = -1;
    let blockStartLine = -1;
    let newLineNum = line;

    for (let i = line; i >= 0; i--) {
        const l = lines[i];
        const match = l.match(/^&%&BLOCK_INDEX_(\d+)&%&$/);
        if (match) {
            blockIndex = parseInt(match[1], 10);
            blockStartLine = i + 1;
            break;
        }
    }

    if (blockIndex !== -1) {
        let extraLines = blockIndex * 2;
        newLineNum += extraLines;
        for (let i = line + 1; i < lines.length && extraLines > 0; i++) {
            const l = lines[i];
            if (l.match(/^&%&BLOCK_INDEX_\d+&%&$/)) {
                extraLines += 2;
                newLineNum += 2;
                blockIndex++;
                blockStartLine = i + 1;
            }
            extraLines--;
        }
        const lineNumber = newLineNum - blockStartLine + 1;
        return { blockIndex, lineNumber };
    }

    return { blockIndex: -1, lineNumber: -1 };
}

function scrollToCurrentPosition(activeEditor: vscode.TextEditor, panel: vscode.WebviewPanel) {
    const markdownContent = addBlockNumbersToMarkdown(activeEditor.document.getText());
    const visibleRanges = activeEditor.visibleRanges;
    if (visibleRanges.length > 0) {
        const midLine = visibleRanges[0].start.line + Math.floor((visibleRanges[0].end.line - visibleRanges[0].start.line) / 2);
        const { blockIndex, lineNumber } = getBlockInfo(markdownContent, midLine);
        panel.webview.postMessage({ command: 'scrollToPosition', blockIndex, lineInBlock: lineNumber });
    }
}

function getWebviewContent(html: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Markdown Preview</title>
</head>
<body>
  <div id="content">${html.replace(/<p>&amp;%&amp;BLOCK_INDEX_(\d+)&amp;%&amp;<\/p>/g, '<div data-block-index="$1"></div>').replace(/&amp;%&amp;BLOCK_INDEX_(\d+)&%&/g, '<div data-block-index="$1"></div>')}</div>
  <script>
  (function() {
    const vscode = acquireVsCodeApi();

    function scrollToPosition(blockIndex, lineInBlock) {
      const elements = document.querySelectorAll('[data-block-index]');
      if (blockIndex >= 0 && blockIndex < elements.length) {
        const targetElement = elements[blockIndex];
        const nextElement = elements[blockIndex + 1];
        const blockHeight = nextElement ? nextElement.offsetTop - targetElement.offsetTop : targetElement.clientHeight;
        const scrollPosition = targetElement.offsetTop + (blockHeight * (lineInBlock / (lineInBlock + 1))) - window.innerHeight / 2;
        window.scrollTo({ top: scrollPosition, behavior: 'auto' });
      }
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.command === 'updateBlocks') {
        const updatedBlocks = message.blocks;
        const contentElement = document.getElementById('content');
        for (const block of updatedBlocks) {
          const blockElement = contentElement.querySelector('[data-block-index="' + block.index + '"]');
          if (blockElement) {
            blockElement.insertAdjacentHTML('afterend', block.html);
            blockElement.remove();
          }
        }
        vscode.postMessage({ command: 'updateComplete' });
      } else if (message.command === 'scrollToPosition') {
        const { blockIndex, lineInBlock } = message;
        scrollToPosition(blockIndex, lineInBlock);
      }
    });
  })();
  </script>
</body>
</html>`;
}

export function deactivate() {}

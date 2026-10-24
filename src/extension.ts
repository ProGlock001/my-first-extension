import * as vscode from "vscode";

// Происхождение каждого символа в файле
const EXISTING = 0; // был в файле до начала отслеживания
const TYPED = 1; // набран вручную
const PASTED = 2; // вставлен из буфера обмена

// Для каждого открытого файла храним массив: один элемент = один символ
const origins = new Map<string, number[]>();

let statusBar: vscode.StatusBarItem;
let highlight: vscode.TextEditorDecorationType;
let highlightOn = false;
let pasting = false; // true, пока выполняется наша команда «Вставить»

export function activate(context: vscode.ExtensionContext) {
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = "copyPasteMeter.showReport";

  highlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(255, 140, 0, 0.2)",
    overviewRulerColor: "orange",
  });

  context.subscriptions.push(
    statusBar,
    highlight,
    vscode.commands.registerCommand("copyPasteMeter.paste", paste),
    vscode.commands.registerCommand("copyPasteMeter.showReport", showReport),
    vscode.commands.registerCommand(
      "copyPasteMeter.toggleHighlight",
      toggleHighlight,
    ),
    vscode.commands.registerCommand("copyPasteMeter.reset", reset),
    vscode.workspace.onDidOpenTextDocument(track),
    vscode.workspace.onDidCloseTextDocument((doc) =>
      origins.delete(doc.uri.toString()),
    ),
    vscode.workspace.onDidChangeTextDocument(onChange),
    vscode.window.onDidChangeActiveTextEditor(updateUI),
  );

  // Файлы, которые уже были открыты при запуске
  vscode.workspace.textDocuments.forEach(track);
  updateUI();
}

export function deactivate() {}

// Начинаем следить за файлом: весь его текущий текст — «до отслеживания»
function track(doc: vscode.TextDocument) {
  if (doc.uri.scheme !== "file" && doc.uri.scheme !== "untitled") {
    return;
  }
  origins.set(
    doc.uri.toString(),
    new Array(doc.getText().length).fill(EXISTING),
  );
}

// Наша замена Ctrl+V: ставим флаг и вызываем стандартную вставку VS Code
async function paste() {
  pasting = true;
  try {
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
  } finally {
    setTimeout(() => (pasting = false), 50);
  }
}

// Определяем, откуда взялся вставленный текст
function classify(text: string): number {
  if (pasting) {
    return PASTED;
  }
  // Большой кусок кода за одну правку (вставка через меню, перетаскивание)
  const threshold = vscode.workspace
    .getConfiguration("copyPasteMeter")
    .get<number>("pasteThreshold", 30);
  if (text.replace(/\s/g, "").length >= threshold) {
    return PASTED;
  }
  return TYPED;
}

// Вызывается при каждом изменении текста в любом файле
function onChange(e: vscode.TextDocumentChangeEvent) {
  const key = e.document.uri.toString();
  let arr = origins.get(key);
  if (!arr) {
    return;
  }
  // Правки применяем с конца, чтобы смещения не сбивались
  const changes = [...e.contentChanges].sort(
    (a, b) => b.rangeOffset - a.rangeOffset,
  );
  for (const c of changes) {
    const added = new Array(c.text.length).fill(classify(c.text));
    arr = arr
      .slice(0, c.rangeOffset)
      .concat(added, arr.slice(c.rangeOffset + c.rangeLength));
  }
  origins.set(key, arr);
  if (e.document === vscode.window.activeTextEditor?.document) {
    updateUI();
  }
}

// Считаем символы каждого типа (пробелы и переводы строк не учитываем)
function count(doc: vscode.TextDocument) {
  const arr = origins.get(doc.uri.toString()) ?? [];
  const text = doc.getText();
  const result = [0, 0, 0]; // [до отслеживания, написано, скопировано]
  for (let i = 0; i < arr.length; i++) {
    if (!/\s/.test(text[i])) {
      result[arr[i]]++;
    }
  }
  const written = result[TYPED] + result[PASTED];
  const pastedPct =
    written === 0 ? 0 : Math.round((result[PASTED] / written) * 100);
  return {
    existing: result[EXISTING],
    typed: result[TYPED],
    pasted: result[PASTED],
    pastedPct,
    typedPct: written === 0 ? 0 : 100 - pastedPct,
  };
}

// Обновляем строку состояния и подсветку
function updateUI() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !origins.has(editor.document.uri.toString())) {
    statusBar.hide();
    return;
  }
  const s = count(editor.document);
  statusBar.text = `$(clippy) ${s.pastedPct}% скопировано  $(edit) ${s.typedPct}% своё`;
  statusBar.tooltip = `Написано: ${s.typed} симв. | Скопировано: ${s.pasted} симв. | До отслеживания: ${s.existing} симв.`;
  statusBar.backgroundColor =
    s.pastedPct >= 50
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
  statusBar.show();

  // Подсветка вставленных фрагментов
  const ranges: vscode.Range[] = [];
  const arr = origins.get(editor.document.uri.toString())!;
  if (highlightOn) {
    let start = -1;
    for (let i = 0; i <= arr.length; i++) {
      if (arr[i] === PASTED && start < 0) {
        start = i;
      } else if (arr[i] !== PASTED && start >= 0) {
        ranges.push(
          new vscode.Range(
            editor.document.positionAt(start),
            editor.document.positionAt(i),
          ),
        );
        start = -1;
      }
    }
  }
  editor.setDecorations(highlight, ranges);
}

function showReport() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !origins.has(editor.document.uri.toString())) {
    vscode.window.showWarningMessage(
      "Откройте файл, чтобы увидеть статистику.",
    );
    return;
  }
  const s = count(editor.document);
  const name = vscode.workspace.asRelativePath(editor.document.uri);
  vscode.window.showInformationMessage(
    `${name}: написано самостоятельно ${s.typedPct}% (${s.typed} симв.), ` +
      `скопировано ${s.pastedPct}% (${s.pasted} симв.). До отслеживания: ${s.existing} симв.`,
  );
}

function toggleHighlight() {
  highlightOn = !highlightOn;
  updateUI();
}

function reset() {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    track(editor.document);
    updateUI();
    vscode.window.showInformationMessage("Статистика файла сброшена.");
  }
}

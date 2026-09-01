#include "MainWindow.h"

#include <QFileDialog>
#include <QHBoxLayout>
#include <QJsonArray>
#include <QLabel>
#include <QLineEdit>
#include <QListView>
#include <QPlainTextEdit>
#include <QSplitter>
#include <QTimer>
#include <QVBoxLayout>
#include <QTextCursor>

#include "AgentProcessManager.h"
#include "ApprovalDialog.h"
#include "SettingsDialog.h"

MainWindow::MainWindow(AgentProcessManager *manager, QWidget *parent) : QMainWindow(parent) {
  manager_ = manager;

  auto *root = new QWidget(this);
  auto *layout = new QVBoxLayout(root);
  auto *top = new QHBoxLayout;
  workspaceField_ = new QLineEdit(root);
  workspaceField_->setReadOnly(true);
  chooseWorkspace_ = new QPushButton(QStringLiteral("Choose workspace"), root);
  chooseWorkspace_->setObjectName(QStringLiteral("chooseWorkspace"));
  settingsButton_ = new QPushButton(QStringLiteral("Settings"), root);
  settingsButton_->setObjectName(QStringLiteral("settings"));
  restart_ = new QPushButton(QStringLiteral("Restart Core"), root);
  restart_->setEnabled(false);
  top->addWidget(new QLabel(QStringLiteral("Workspace"), root));
  top->addWidget(workspaceField_, 1);
  top->addWidget(chooseWorkspace_);
  top->addWidget(new QLabel(QStringLiteral("Core"), root));
  top->addWidget(settingsButton_);
  top->addWidget(restart_);
  layout->addLayout(top);

  auto *splitter = new QSplitter(root);
  auto *left = new QWidget(splitter);
  auto *leftLayout = new QVBoxLayout(left);
  newSession_ = new QPushButton(QStringLiteral("New session"), left);
  newSession_->setObjectName(QStringLiteral("newSession"));
  sessionView_ = new QListView(left);
  sessionView_->setObjectName(QStringLiteral("sessionList"));
  sessionView_->setModel(&sessions_);
  leftLayout->addWidget(newSession_);
  leftLayout->addWidget(sessionView_);
  transcript_ = new QPlainTextEdit(splitter);
  transcript_->setReadOnly(true);
  auto *toolView = new QListView(splitter);
  toolView->setModel(&tools_);
  splitter->addWidget(left);
  splitter->addWidget(transcript_);
  splitter->addWidget(toolView);
  splitter->setStretchFactor(1, 1);
  layout->addWidget(splitter, 1);

  taskInput_ = new QPlainTextEdit(root);
  taskInput_->setObjectName(QStringLiteral("taskInput"));
  taskInput_->setPlaceholderText(QStringLiteral("Describe the coding task…"));
  layout->addWidget(taskInput_);
  auto *bottom = new QHBoxLayout;
  run_ = new QPushButton(QStringLiteral("Run"), root);
  cancel_ = new QPushButton(QStringLiteral("Cancel"), root);
  cancel_->setObjectName(QStringLiteral("cancel"));
  cancel_->setEnabled(false);
  bottom->addStretch();
  bottom->addWidget(run_);
  bottom->addWidget(cancel_);
  layout->addLayout(bottom);
  stderr_ = new QPlainTextEdit(root);
  stderr_->setReadOnly(true);
  stderr_->setPlaceholderText(QStringLiteral("Core stderr and protocol diagnostics"));
  stderr_->setMaximumBlockCount(500);
  layout->addWidget(stderr_);
  setCentralWidget(root);
  setWindowTitle(QStringLiteral("AwaCode Agent Console"));
  resize(1200, 760);
  setConfigured(false);

  streamTimer_ = new QTimer(this);
  streamTimer_->setInterval(16);
  connect(streamTimer_, &QTimer::timeout, this, &MainWindow::flushBufferedText);
  connect(chooseWorkspace_, &QPushButton::clicked, this, &MainWindow::chooseWorkspace);
  connect(newSession_, &QPushButton::clicked, this, &MainWindow::createSession);
  connect(sessionView_, &QListView::clicked, this, &MainWindow::selectSession);
  connect(run_, &QPushButton::clicked, this, &MainWindow::runTask);
  connect(cancel_, &QPushButton::clicked, this, [this] { if (manager_) manager_->cancel(); });
  connect(settingsButton_, &QPushButton::clicked, this, &MainWindow::showSettings);
  connect(restart_, &QPushButton::clicked, this, [this] {
    if (manager_ != nullptr) { manager_->restart(); restart_->setEnabled(false); }
  });

  if (manager_ != nullptr) {
    connect(manager_, &AgentProcessManager::notificationReceived, this, &MainWindow::receiveNotification);
    connect(manager_, &AgentProcessManager::approvalRequested, this, &MainWindow::handleApproval);
    connect(manager_, &AgentProcessManager::responseReceived, this, &MainWindow::handleResponse);
    connect(manager_, &AgentProcessManager::responseError, this, &MainWindow::handleResponseError);
    connect(manager_, &AgentProcessManager::stderrReceived, stderr_, &QPlainTextEdit::appendPlainText);
    connect(manager_, &AgentProcessManager::protocolError, stderr_, &QPlainTextEdit::appendPlainText);
    connect(manager_, &AgentProcessManager::crashed, this, &MainWindow::coreCrashed);
    connect(manager_, &AgentProcessManager::stopped, this, &MainWindow::coreStopped);
    connect(manager_, &AgentProcessManager::started, this, [this] { sendRequest(QStringLiteral("core/hello")); });
  }
}

QPushButton *MainWindow::runButton() const { return run_; }
QPushButton *MainWindow::restartButton() const { return restart_; }
QString MainWindow::transcriptText() const { return transcript_->toPlainText(); }
QString MainWindow::toolTimelineText(int row) const { return tools_.displayText(row); }

void MainWindow::setConfigured(bool configured, const QString &model) {
  configured_ = configured;
  run_->setEnabled(configured_ && !running_);
  if (!model.isEmpty()) setWindowTitle(QStringLiteral("AwaCode Agent Console — %1").arg(model));
}

void MainWindow::receiveNotification(const QString &method, const QJsonObject &params) {
  if (method == QStringLiteral("stream/text")) {
    const QString messageId = params.value("messageId").toString();
    TranscriptEntry *entry = nullptr;
    for (TranscriptEntry &candidate : transcriptEntries_) {
      if (candidate.messageId == messageId) entry = &candidate;
    }
    if (entry == nullptr) {
      transcriptEntries_.append({{}, messageId, true});
      entry = &transcriptEntries_.last();
    }
    entry->text.append(params.value("delta").toString());
    entry->provisional = params.value("provisional").toBool();
    if (!streamTimer_->isActive()) streamTimer_->start();
  } else if (method == QStringLiteral("stream/commit")) {
    streamTimer_->stop();
    const QString messageId = params.value("messageId").toString();
    for (TranscriptEntry &entry : transcriptEntries_) {
      if (entry.messageId == messageId) entry.provisional = false;
    }
    renderTranscript();
  } else if (method == QStringLiteral("agent/phase")) {
    appendTranscript(QStringLiteral("\n[%1]\n").arg(params.value("phase").toString()));
  } else if (method == QStringLiteral("tool/start")) {
    tools_.started(params);
  } else if (method == QStringLiteral("tool/end")) {
    tools_.finished(params);
  } else if (method == QStringLiteral("agent/status")) {
    const QString status = params.value("status").toString();
    setRunning(status == QStringLiteral("busy"));
  }
}

void MainWindow::coreCrashed(int exitCode) {
  flushBufferedText();
  appendTranscript(QStringLiteral("\n[Core interrupted (exit %1); displayed content is preserved.]\n").arg(exitCode));
  setRunning(false);
  restart_->setEnabled(true);
}

void MainWindow::coreStopped(bool cleanEof) {
  flushBufferedText();
  setRunning(false);
  if (!cleanEof) {
    appendTranscript(QStringLiteral("\n[Core ended unexpectedly; displayed content is preserved.]\n"));
    restart_->setEnabled(true);
  }
}

void MainWindow::chooseWorkspace() {
  const QString workspace = QFileDialog::getExistingDirectory(this, QStringLiteral("Choose workspace"), workspace_);
  if (workspace.isEmpty()) return;
  workspace_ = workspace;
  workspaceField_->setText(workspace_);
  sendRequest(QStringLiteral("workspace/set"), {{"workspace", workspace_}});
}

void MainWindow::createSession() {
  if (projectId_.isEmpty()) return;
  sendRequest(QStringLiteral("session/create"), {{"projectId", projectId_}});
}

void MainWindow::runTask() {
  const QString prompt = taskInput_->toPlainText().trimmed();
  if (prompt.isEmpty() || !configured_) return;
  if (sessionId_.isEmpty()) {
    createSession();
    return;
  }
  tools_.clear();
  appendTranscript(QStringLiteral("\nYou: %1\n").arg(prompt));
  sendRequest(QStringLiteral("agent/run"), {{"sessionId", sessionId_}, {"prompt", prompt}});
  setRunning(true);
}

void MainWindow::selectSession(const QModelIndex &index) {
  sessionId_ = sessions_.data(index, SessionListModel::SessionIdRole).toString();
  loadSession(sessionId_);
}

void MainWindow::flushBufferedText() {
  if (!streamTimer_->isActive()) {
    streamTimer_->stop();
    return;
  }
  renderTranscript();
  streamTimer_->stop();
  emit streamFlushed();
}

void MainWindow::handleResponse(const QString &id, const QJsonValue &result) {
  const QString method = pendingMethods_.take(id);
  receiveResponse(method, result);
}

void MainWindow::receiveResponse(const QString &method, const QJsonValue &result) {
  const QJsonObject object = result.toObject();
  if (method == QStringLiteral("core/hello")) {
    setConfigured(object.value("configured").toBool(), object.value("model").toString());
  } else if (method == QStringLiteral("workspace/set")) {
    projectId_ = object.value("projectId").toString();
    workspace_ = object.value("workspace").toString();
    workspaceField_->setText(workspace_);
    loadSessions();
  } else if (method == QStringLiteral("session/list")) {
    QList<SessionSummary> sessions;
    for (const QJsonValue &value : result.toArray()) {
      const QJsonObject session = value.toObject();
      sessions.append({session.value("id").toString(), session.value("title").toString(), session.value("status").toString()});
    }
    sessions_.setSessions(sessions);
  } else if (method == QStringLiteral("session/create")) {
    sessionId_ = object.value("id").toString();
    sessions_.prepend({sessionId_, object.value("title").toString(), object.value("status").toString()});
    runTask();
  } else if (method == QStringLiteral("session/load")) {
    transcriptEntries_.clear();
    for (const QJsonValue &value : object.value("messages").toArray()) {
      const QJsonObject message = value.toObject();
      const QString text = payloadText(message);
      if (!text.isEmpty()) appendTranscript(QStringLiteral("%1: %2\n").arg(message.value("role").toString(), text));
    }
    tools_.hydrate(object.value("toolCalls").toArray());
  } else if (method == QStringLiteral("agent/run")) {
    setRunning(false);
  } else if (method == QStringLiteral("config/save") || method == QStringLiteral("config/status")) {
    setConfigured(object.value("runnable").toBool(), object.value("model").toString());
    if (settingsDialog_ != nullptr) {
      settingsDialog_->applyStatus(object);
      if (method == QStringLiteral("config/save")) settingsDialog_->showSaveResult(QStringLiteral("Configuration saved"));
    }
  } else if (method == QStringLiteral("config/test")) {
    if (settingsDialog_ != nullptr) settingsDialog_->setStatusText(object.value("message").toString());
  }
}

void MainWindow::handleResponseError(const QString &id, const QJsonObject &error) {
  receiveError(pendingMethods_.take(id), error);
}

void MainWindow::receiveError(const QString &method, const QJsonObject &error) {
  const QString message = error.value("message").toString(QStringLiteral("Core request failed"));
  stderr_->appendPlainText(QStringLiteral("%1: %2").arg(method, message));
  appendTranscript(QStringLiteral("\n[Core error: %1]\n").arg(message));
  if (method == QStringLiteral("agent/run") || method == QStringLiteral("agent/cancel")) setRunning(false);
  if ((method == QStringLiteral("config/save") || method == QStringLiteral("config/test") || method == QStringLiteral("config/status")) && settingsDialog_ != nullptr) {
    if (method == QStringLiteral("config/save")) settingsDialog_->showSaveResult(message);
    else settingsDialog_->setStatusText(message);
  }
}

void MainWindow::showSettings() {
  SettingsDialog dialog(this);
  settingsDialog_ = &dialog;
  connect(&dialog, &SettingsDialog::saveRequested, this, [this](const QJsonObject &settings) { sendRequest(QStringLiteral("config/save"), settings); });
  connect(&dialog, &SettingsDialog::testRequested, this, [this] { sendRequest(QStringLiteral("config/test")); });
  sendRequest(QStringLiteral("config/status"));
  dialog.exec();
  settingsDialog_.clear();
}

QString MainWindow::sendRequest(const QString &method, const QJsonObject &params) {
  if (manager_ == nullptr || !manager_->isRunning()) return {};
  const QString id = manager_->request(method, params);
  pendingMethods_.insert(id, method);
  return id;
}

void MainWindow::setRunning(bool running) {
  running_ = running;
  run_->setEnabled(configured_ && !running_);
  cancel_->setEnabled(running_);
  workspaceField_->setEnabled(!running_);
  chooseWorkspace_->setEnabled(!running_);
  newSession_->setEnabled(!running_);
  sessionView_->setEnabled(!running_);
  settingsButton_->setEnabled(!running_);
  taskInput_->setEnabled(!running_);
}

void MainWindow::appendTranscript(const QString &text) {
  transcriptEntries_.append({text, {}, false});
  renderTranscript();
}

void MainWindow::renderTranscript() {
  QString text;
  for (const TranscriptEntry &entry : transcriptEntries_) {
    text += entry.provisional
      ? QStringLiteral("[provisional] %1").arg(entry.text)
      : entry.text;
  }
  transcript_->setPlainText(text);
  transcript_->moveCursor(QTextCursor::End);
}

QString MainWindow::payloadText(const QJsonObject &message) const {
  const QJsonValue payload = message.value("payload");
  if (payload.isObject()) {
    const QJsonObject object = payload.toObject();
    if (object.value("text").isString()) return object.value("text").toString();
  }
  return {};
}

void MainWindow::loadSessions() { sendRequest(QStringLiteral("session/list"), {{"projectId", projectId_}}); }
void MainWindow::loadSession(const QString &sessionId) { sendRequest(QStringLiteral("session/load"), {{"sessionId", sessionId}}); }

void MainWindow::handleApproval(const QString &id, const QJsonObject &params) {
  tools_.markApproval(params.value("callId").toString(), QStringLiteral("awaiting approval"));
  ApprovalDialog dialog(params, this);
  dialog.exec();
  if (manager_ != nullptr) manager_->replyToApproval(id, dialog.decision());
}

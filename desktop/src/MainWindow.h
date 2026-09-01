#pragma once

#include <QHash>
#include <QJsonObject>
#include <QMainWindow>
#include <QPushButton>

#include "SessionListModel.h"
#include "ToolTimelineModel.h"

class AgentProcessManager;
class QLineEdit;
class QPlainTextEdit;
class QTimer;

class MainWindow final : public QMainWindow {
  Q_OBJECT

public:
  explicit MainWindow(AgentProcessManager *manager = nullptr, QWidget *parent = nullptr);
  QPushButton *runButton() const;
  QPushButton *restartButton() const;
  QString transcriptText() const;
  void setConfigured(bool configured, const QString &model = {});
  void receiveNotification(const QString &method, const QJsonObject &params);
  void coreCrashed(int exitCode);

private slots:
  void chooseWorkspace();
  void createSession();
  void runTask();
  void selectSession(const QModelIndex &index);
  void flushBufferedText();
  void handleResponse(const QString &id, const QJsonObject &result);
  void showSettings();

private:
  QString sendRequest(const QString &method, const QJsonObject &params = {});
  void setRunning(bool running);
  void appendTranscript(const QString &text);
  void loadSessions();
  void loadSession(const QString &sessionId);
  void handleApproval(const QString &id, const QJsonObject &params);

  AgentProcessManager *manager_ = nullptr;
  bool ownsManager_ = false;
  bool configured_ = false;
  bool running_ = false;
  QString workspace_;
  QString projectId_;
  QString sessionId_;
  QHash<QString, QString> pendingMethods_;
  QHash<QString, QString> provisionalText_;
  SessionListModel sessions_;
  ToolTimelineModel tools_;
  QLineEdit *workspaceField_ = nullptr;
  QPlainTextEdit *transcript_ = nullptr;
  QPlainTextEdit *taskInput_ = nullptr;
  QPlainTextEdit *stderr_ = nullptr;
  QPushButton *run_ = nullptr;
  QPushButton *cancel_ = nullptr;
  QPushButton *restart_ = nullptr;
  QTimer *streamTimer_ = nullptr;
};

#pragma once

#include <QHash>
#include <QJsonObject>
#include <QJsonValue>
#include <QMainWindow>
#include <QPointer>
#include <QPushButton>

#include "SessionListModel.h"
#include "ToolTimelineModel.h"

class AgentProcessManager;
class QLineEdit;
class QListView;
class QPlainTextEdit;
class QTimer;
class SettingsDialog;

class MainWindow final : public QMainWindow {
  Q_OBJECT

public:
  explicit MainWindow(AgentProcessManager *manager = nullptr, QWidget *parent = nullptr);
  QPushButton *runButton() const;
  QPushButton *restartButton() const;
  QString transcriptText() const;
  QString toolTimelineText(int row) const;
  void setConfigured(bool configured, const QString &model = {});
  void receiveNotification(const QString &method, const QJsonObject &params);
  void receiveResponse(const QString &method, const QJsonValue &result);
  void receiveError(const QString &method, const QJsonObject &error);
  void coreCrashed(int exitCode);
  void coreStopped(bool cleanEof);

signals:
  void streamFlushed();

private slots:
  void chooseWorkspace();
  void createSession();
  void runTask();
  void selectSession(const QModelIndex &index);
  void flushBufferedText();
  void handleResponse(const QString &id, const QJsonValue &result);
  void handleResponseError(const QString &id, const QJsonObject &error);
  void showSettings();

private:
  QString sendRequest(const QString &method, const QJsonObject &params = {});
  void setRunning(bool running);
  void appendTranscript(const QString &text);
  void loadSessions();
  void loadSession(const QString &sessionId);
  void handleApproval(const QString &id, const QJsonObject &params);
  void renderTranscript();
  void foldStreamMessagesIntoBase();
  QString payloadText(const QJsonObject &message) const;

  struct StreamMessage {
    QString text;
    bool provisional = true;
    bool committed = false;
  };

  AgentProcessManager *manager_ = nullptr;
  bool configured_ = false;
  bool running_ = false;
  QString workspace_;
  QString projectId_;
  QString sessionId_;
  QHash<QString, QString> pendingMethods_;
  QHash<QString, StreamMessage> streamMessages_;
  QStringList streamMessageOrder_;
  QString transcriptBase_;
  SessionListModel sessions_;
  ToolTimelineModel tools_;
  QLineEdit *workspaceField_ = nullptr;
  QPushButton *chooseWorkspace_ = nullptr;
  QPushButton *newSession_ = nullptr;
  QPushButton *settingsButton_ = nullptr;
  QListView *sessionView_ = nullptr;
  QPlainTextEdit *transcript_ = nullptr;
  QPlainTextEdit *taskInput_ = nullptr;
  QPlainTextEdit *stderr_ = nullptr;
  QPushButton *run_ = nullptr;
  QPushButton *cancel_ = nullptr;
  QPushButton *restart_ = nullptr;
  QTimer *streamTimer_ = nullptr;
  QPointer<SettingsDialog> settingsDialog_;
};

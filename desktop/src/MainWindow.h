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
  void receiveResponseForEpoch(const QString &method, const QJsonValue &result, quint64 epoch);
  quint64 beginRequestGeneration(const QString &method, const QString &target = {});
  void receiveResponseForGeneration(const QString &method, const QJsonValue &result, quint64 epoch,
                                    quint64 generation, const QString &target = {},
                                    bool createForRun = false, const QString &prompt = {});
  quint64 beginWorkspaceSelection(const QString &workspace);
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
  enum class RequestIntent { Normal, ManualSessionCreate, CreateForRun };
  struct PendingRequest {
    QString method;
    quint64 epoch = 0;
    quint64 connectionGeneration = 0;
    quint64 generation = 0;
    QString target;
    RequestIntent intent = RequestIntent::Normal;
    QString prompt;
  };

  QString sendRequest(const QString &method, const QJsonObject &params = {},
                      RequestIntent intent = RequestIntent::Normal, const QString &prompt = {});
  void processResponse(const QString &method, const QJsonValue &result, RequestIntent intent, const QString &prompt);
  bool isCurrentRequest(const PendingRequest &pending) const;
  void dispatchRun(const QString &prompt);
  void invalidateCoreState();
  void updateControls();
  void setRunning(bool running);
  void appendTranscript(const QString &text);
  void loadSessions();
  void loadSession(const QString &sessionId);
  void handleApproval(const QString &id, const QJsonObject &params);
  void renderTranscript();
  QString payloadText(const QJsonObject &message) const;

  struct TranscriptEntry {
    QString text;
    QString messageId;
    bool provisional = true;
    bool rejected = false;
  };

  AgentProcessManager *manager_ = nullptr;
  bool configured_ = false;
  bool coreAlive_ = false;
  bool running_ = false;
  bool dispatchPending_ = false;
  quint64 workspaceEpoch_ = 0;
  quint64 connectionGeneration_ = 1;
  quint64 sessionListGeneration_ = 0;
  quint64 sessionLoadGeneration_ = 0;
  quint64 sessionCreateGeneration_ = 0;
  QString sessionListTarget_;
  QString sessionLoadTarget_;
  QString sessionCreateTarget_;
  QString workspace_;
  QString projectId_;
  QString sessionId_;
  QHash<QString, PendingRequest> pendingRequests_;
  QString currentRunRequestId_;
  QList<TranscriptEntry> transcriptEntries_;
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

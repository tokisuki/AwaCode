#pragma once

#include <QJsonObject>
#include <QObject>
#include <QProcess>

#include "RpcCodec.h"

class AgentProcessManager final : public QObject {
  Q_OBJECT

public:
  explicit AgentProcessManager(QString program, QStringList arguments = {}, QObject *parent = nullptr);

  void start();
  void restart();
  void closeInput();
  void cancel();
  QString request(const QString &method, const QJsonObject &params = {});
  void replyToApproval(const QString &requestId, const QString &decision);
  bool isRunning() const;
  QString stderrText() const;

signals:
  void started();
  void stopped(bool cleanEof);
  void crashed(int exitCode);
  void protocolError(const QString &message);
  void stderrReceived(const QString &text);
  void notificationReceived(const QString &method, const QJsonObject &params);
  void approvalRequested(const QString &requestId, const QJsonObject &params);
  void responseReceived(const QString &requestId, const QJsonObject &result);
  void responseError(const QString &requestId, const QJsonObject &error);

private slots:
  void readStandardOutput();
  void readStandardError();
  void processMessage(const QJsonObject &message);

private:
  void write(const QJsonObject &message);
  QString program_;
  QStringList arguments_;
  QProcess process_;
  RpcCodec codec_;
  QString stderr_;
  int nextRequestId_ = 1;
  bool inputClosed_ = false;
};

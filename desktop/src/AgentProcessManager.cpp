#include "AgentProcessManager.h"

AgentProcessManager::AgentProcessManager(QString program, QStringList arguments, QObject *parent)
    : QObject(parent), program_(std::move(program)), arguments_(std::move(arguments)) {
  connect(&process_, &QProcess::started, this, &AgentProcessManager::started);
  connect(&process_, &QProcess::readyReadStandardOutput, this, &AgentProcessManager::readStandardOutput);
  connect(&process_, &QProcess::readyReadStandardError, this, &AgentProcessManager::readStandardError);
  connect(&process_, &QProcess::errorOccurred, this, [this](QProcess::ProcessError error) {
    if (error == QProcess::FailedToStart) emit crashed(-1);
  });
  connect(&process_, qOverload<int, QProcess::ExitStatus>(&QProcess::finished), this,
          [this](int exitCode, QProcess::ExitStatus status) {
            readStandardOutput();
            readStandardError();
            const bool validEof = codec_.finish();
            if (!codec_.failed() && status == QProcess::NormalExit && exitCode == 0 && validEof) {
              emit stopped(inputClosed_);
            }
            else {
              if (codec_.failed()) emit protocolError(codec_.errorString());
              emit crashed(exitCode);
            }
          });
}

void AgentProcessManager::start() {
  if (isRunning()) return;
  codec_ = RpcCodec{};
  stderr_.clear();
  inputClosed_ = false;
  process_.setProgram(program_);
  process_.setArguments(arguments_);
  process_.start();
}

void AgentProcessManager::restart() {
  if (isRunning()) process_.kill();
  start();
}

void AgentProcessManager::closeInput() {
  if (!isRunning() || inputClosed_) return;
  inputClosed_ = true;
  process_.closeWriteChannel();
}

void AgentProcessManager::cancel() { request(QStringLiteral("agent/cancel")); }

QString AgentProcessManager::request(const QString &method, const QJsonObject &params) {
  const QString id = QStringLiteral("ui-%1").arg(nextRequestId_++);
  write({{"jsonrpc", "2.0"}, {"id", id}, {"method", method}, {"params", params}});
  return id;
}

void AgentProcessManager::replyToApproval(const QString &requestId, const QString &decision) {
  if (decision != QStringLiteral("allow_once") && decision != QStringLiteral("deny")) {
    emit protocolError(QStringLiteral("invalid_approval_decision"));
    return;
  }
  write({{"jsonrpc", "2.0"}, {"id", requestId}, {"result", decision}});
}

bool AgentProcessManager::isRunning() const { return process_.state() != QProcess::NotRunning; }

QString AgentProcessManager::stderrText() const { return stderr_; }

void AgentProcessManager::readStandardOutput() {
  const QList<QJsonObject> messages = codec_.feed(process_.readAllStandardOutput());
  if (codec_.failed()) {
    emit protocolError(codec_.errorString());
    process_.kill();
    return;
  }
  for (const QJsonObject &message : messages) processMessage(message);
}

void AgentProcessManager::readStandardError() {
  const QString text = QString::fromUtf8(process_.readAllStandardError());
  if (text.isEmpty()) return;
  stderr_.append(text);
  emit stderrReceived(text);
}

void AgentProcessManager::processMessage(const QJsonObject &message) {
  const QString id = message.value("id").toString();
  const QString method = message.value("method").toString();
  if (!method.isEmpty()) {
    const QJsonObject params = message.value("params").toObject();
    if (!id.isEmpty() && method == QStringLiteral("permission/request")) emit approvalRequested(id, params);
    else if (id.isEmpty()) emit notificationReceived(method, params);
    else replyToApproval(id, QStringLiteral("deny"));
    return;
  }
  if (id.isEmpty()) {
    emit protocolError(QStringLiteral("invalid_response"));
    return;
  }
  if (message.contains("result")) emit responseReceived(id, message.value("result"));
  else if (message.contains("error")) emit responseError(id, message.value("error").toObject());
  else emit protocolError(QStringLiteral("invalid_response"));
}

void AgentProcessManager::write(const QJsonObject &message) {
  if (!isRunning() || inputClosed_) {
    emit protocolError(QStringLiteral("disconnected"));
    return;
  }
  process_.write(RpcCodec::encode(message));
}

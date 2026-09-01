#include <QCoreApplication>
#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QTextStream>

#include "AgentProcessManager.h"

class RealCoreProbe final : public QObject {
  Q_OBJECT

public:
  RealCoreProbe(QString node, QString core, QString workspace, QObject *parent = nullptr)
      : QObject(parent), manager_(std::move(node), {std::move(core)}, this), workspace_(std::move(workspace)) {
    connect(&manager_, &AgentProcessManager::started, this, [this] {
      if (phase_ == Phase::Start) {
        phase_ = Phase::Workspace;
        request("workspace/set", {{"workspace", workspace_}});
      } else if (phase_ == Phase::Reload) {
        request("session/load", {{"sessionId", sessionId_}});
      }
    });
    connect(&manager_, &AgentProcessManager::approvalRequested, this, [this](const QString &id, const QJsonObject &) {
      manager_.replyToApproval(id, QStringLiteral("allow_once"));
    });
    connect(&manager_, &AgentProcessManager::responseReceived, this, &RealCoreProbe::response);
    connect(&manager_, &AgentProcessManager::responseError, this, [this](const QString &, const QJsonObject &error) {
      fail(error.value("message").toString());
    });
    connect(&manager_, &AgentProcessManager::crashed, this, [this](int code) { fail(QStringLiteral("Core crashed: %1").arg(code)); });
    connect(&manager_, &AgentProcessManager::stopped, this, [this](bool clean) {
      if (!clean) return fail(QStringLiteral("unexpected Core EOF"));
      if (phase_ == Phase::CloseAfterRun) {
        phase_ = Phase::Reload;
        manager_.restart();
      } else if (phase_ == Phase::CloseAfterLoad) {
        QTextStream(stdout) << "qt-real-core-ok\n";
        QCoreApplication::exit(0);
      }
    });
  }

  void start() { manager_.start(); }

private:
  enum class Phase { Start, Workspace, Create, Run, CloseAfterRun, Reload, CloseAfterLoad, Failed };

  void request(const QString &method, const QJsonObject &params) { methods_.insert(manager_.request(method, params), method); }

  void response(const QString &id, const QJsonValue &result) {
    const QString method = methods_.take(id);
    const QJsonObject object = result.toObject();
    if (method == QStringLiteral("workspace/set")) {
      projectId_ = object.value("projectId").toString();
      phase_ = Phase::Create;
      request("session/create", {{"projectId", projectId_}, {"title", "Qt real Core"}});
    } else if (method == QStringLiteral("session/create")) {
      sessionId_ = object.value("id").toString();
      phase_ = Phase::Run;
      request("agent/run", {{"sessionId", sessionId_}, {"prompt", "Fix the failing total test"}});
    } else if (method == QStringLiteral("agent/run")) {
      if (object.value("status").toString() != QStringLiteral("completed")) return fail(QStringLiteral("run did not complete"));
      phase_ = Phase::CloseAfterRun;
      manager_.closeInput();
    } else if (method == QStringLiteral("session/load")) {
      if (object.value("messages").toArray().isEmpty() || object.value("toolCalls").toArray().size() != 5) {
        return fail(QStringLiteral("display-only reload did not return durable history"));
      }
      phase_ = Phase::CloseAfterLoad;
      manager_.closeInput();
    }
  }

  void fail(const QString &message) {
    if (phase_ == Phase::Failed) return;
    phase_ = Phase::Failed;
    QTextStream(stderr) << message << '\n';
    QCoreApplication::exit(1);
  }

  AgentProcessManager manager_;
  QString workspace_;
  QString projectId_;
  QString sessionId_;
  QHash<QString, QString> methods_;
  Phase phase_ = Phase::Start;
};

int main(int argc, char *argv[]) {
  QCoreApplication app(argc, argv);
  if (app.arguments().size() != 4) return 2;
  RealCoreProbe probe(app.arguments().at(1), app.arguments().at(2), app.arguments().at(3));
  probe.start();
  return app.exec();
}

#include "real_core_probe.moc"

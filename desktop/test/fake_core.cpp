#include <QCoreApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTextStream>

namespace {
void send(const QJsonObject &message) {
  QTextStream output(stdout);
  output << QJsonDocument(message).toJson(QJsonDocument::Compact) << Qt::endl;
}
}

int main(int argc, char *argv[]) {
  QCoreApplication app(argc, argv);
  if (app.arguments().contains("--crash")) return 17;
  if (app.arguments().contains("--eof")) return 0;

  QTextStream input(stdin);
  QString helloId;
  while (!input.atEnd()) {
    const QJsonDocument document = QJsonDocument::fromJson(input.readLine().toUtf8());
    const QJsonObject message = document.object();
    if (message.value("method").toString() == "core/hello") {
      helloId = message.value("id").toString();
      send({{"jsonrpc", "2.0"}, {"method", "stream/text"}, {"params", QJsonObject{{"delta", "hello"}}}});
      send({{"jsonrpc", "2.0"}, {"id", "core-1"}, {"method", "permission/request"},
            {"params", QJsonObject{{"callId", "call-1"}, {"kind", "command"}, {"title", "Run test"}}}});
    } else if (message.value("id").toString() == "core-1") {
      if (message.value("result").toString() != "allow_once") return 19;
      send({{"jsonrpc", "2.0"}, {"id", helloId},
            {"result", QJsonObject{{"configured", false}, {"approvalAccepted", true}}}});
    } else if (message.value("method").toString() == "session/list") {
      send({{"jsonrpc", "2.0"}, {"id", message.value("id").toString()},
            {"result", QJsonArray{QJsonObject{{"id", "session-1"}, {"title", "Session"}, {"status", "idle"}}}}});
    }
  }
  return 0;
}

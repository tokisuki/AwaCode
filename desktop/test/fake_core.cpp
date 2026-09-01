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

  QTextStream input(stdin);
  while (!input.atEnd()) {
    const QJsonDocument document = QJsonDocument::fromJson(input.readLine().toUtf8());
    const QJsonObject message = document.object();
    if (message.value("method").toString() == "core/hello") {
      send({{"jsonrpc", "2.0"}, {"method", "stream/text"}, {"params", QJsonObject{{"delta", "hello"}}}});
      send({{"jsonrpc", "2.0"}, {"id", "core-1"}, {"method", "permission/request"},
            {"params", QJsonObject{{"callId", "call-1"}, {"kind", "command"}, {"title", "Run test"}}}});
      send({{"jsonrpc", "2.0"}, {"id", message.value("id").toString()},
            {"result", QJsonObject{{"configured", false}}}});
    } else if (message.value("method").toString() == "session/list") {
      send({{"jsonrpc", "2.0"}, {"id", message.value("id").toString()},
            {"result", QJsonArray{QJsonObject{{"id", "session-1"}, {"title", "Session"}, {"status", "idle"}}}}});
    }
  }
  return 0;
}

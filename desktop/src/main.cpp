#include <QApplication>
#include <QDir>

#include "AgentProcessManager.h"
#include "MainWindow.h"

int main(int argc, char *argv[]) {
  QApplication app(argc, argv);
  const QString node = qEnvironmentVariable("AWACODE_NODE_PATH", QStringLiteral("node"));
  AgentProcessManager manager(node, {QDir::current().filePath(QStringLiteral("core/dist/index.js"))});
  MainWindow window(&manager);
  window.show();
  manager.start();
  return app.exec();
}

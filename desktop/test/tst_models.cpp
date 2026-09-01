#include <QtTest>

#include "SessionListModel.h"
#include "ToolTimelineModel.h"

class ModelsTest final : public QObject {
  Q_OBJECT

private slots:
  void exposesInterruptedSession();
  void completesTimelineEntry();
};

void ModelsTest::exposesInterruptedSession() {
  SessionListModel sessions;
  sessions.setSessions({SessionSummary{"session-1", "Fix cart", "interrupted"}});
  QCOMPARE(sessions.rowCount(), 1);
  QCOMPARE(sessions.data(sessions.index(0, 0), Qt::DisplayRole).toString(), QStringLiteral("Fix cart [interrupted]"));
  QCOMPARE(sessions.data(sessions.index(0, 0), SessionListModel::SessionIdRole).toString(), QStringLiteral("session-1"));
}

void ModelsTest::completesTimelineEntry() {
  ToolTimelineModel tools;
  tools.started(QJsonObject{{"callId", "call-1"}, {"ordinal", 1}, {"name", "run_command"}});
  tools.finished(QJsonObject{{"callId", "call-1"}, {"status", "success"}, {"durationMs", 31}, {"summary", "tests pass"}});
  QCOMPARE(tools.rowCount(), 1);
  QCOMPARE(tools.data(tools.index(0, 0), Qt::DisplayRole).toString(), QStringLiteral("run_command — success (31 ms): tests pass"));
}

QTEST_MAIN(ModelsTest)
#include "tst_models.moc"

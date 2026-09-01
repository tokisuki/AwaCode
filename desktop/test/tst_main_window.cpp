#include <QtTest>

#include <QJsonArray>
#include <QListView>
#include <QPushButton>

#include "MainWindow.h"

class MainWindowTest final : public QObject {
  Q_OBJECT

private slots:
  void disablesRunUntilConfigured();
  void batchesMultipleProvisionalDeltasOnceAndCommitsThem();
  void hydratesPayloadMessagesAndToolCalls();
  void disablesConflictingControlsWhileRunning();
  void displaysRpcErrorsAndRestoresRunState();
  void marksInterruptedContentAfterCoreCrash();
  void marksUnexpectedEofRestartable();
};

void MainWindowTest::disablesRunUntilConfigured() {
  MainWindow window;
  QVERIFY(!window.runButton()->isEnabled());
  window.setConfigured(true, QStringLiteral("demo-model"));
  QVERIFY(window.runButton()->isEnabled());
}

void MainWindowTest::batchesMultipleProvisionalDeltasOnceAndCommitsThem() {
  MainWindow window;
  QSignalSpy flushed(&window, &MainWindow::streamFlushed);
  window.receiveNotification("stream/text", QJsonObject{
    {"runId", "run-1"}, {"eventSeq", 1}, {"messageId", "message-1"},
    {"phase", "execute"}, {"delta", "first "}, {"provisional", true},
  });
  window.receiveNotification("stream/text", QJsonObject{
    {"runId", "run-1"}, {"eventSeq", 2}, {"messageId", "message-1"},
    {"phase", "execute"}, {"delta", "token"}, {"provisional", true},
  });
  QVERIFY(!window.transcriptText().contains(QStringLiteral("first token")));
  QTRY_COMPARE_WITH_TIMEOUT(flushed.count(), 1, 200);
  QVERIFY(window.transcriptText().contains(QStringLiteral("[provisional] first token")));
  window.receiveNotification("stream/commit", QJsonObject{{"runId", "run-1"}, {"eventSeq", 3}, {"messageId", "message-1"}});
  QCOMPARE(flushed.count(), 1);
  QVERIFY(window.transcriptText().contains(QStringLiteral("first token")));
  QVERIFY(!window.transcriptText().contains(QStringLiteral("[provisional]")));
}

void MainWindowTest::hydratesPayloadMessagesAndToolCalls() {
  MainWindow window;
  window.receiveResponse("session/load", QJsonObject{
    {"session", QJsonObject{{"id", "session-1"}}},
    {"messages", QJsonArray{
      QJsonObject{{"role", "user"}, {"kind", "text"}, {"payload", QJsonObject{{"text", "Fix the bug"}}}},
      QJsonObject{{"role", "assistant"}, {"kind", "plan"}, {"payload", QJsonObject{{"text", "Inspect tests"}}}},
    }},
    {"toolCalls", QJsonArray{QJsonObject{{"callId", "call-1"}, {"toolName", "run_command"}, {"status", "success"}, {"result", QJsonObject{{"summary", "tests pass"}}}}}},
  });
  QVERIFY(window.transcriptText().contains(QStringLiteral("Fix the bug")));
  QVERIFY(window.transcriptText().contains(QStringLiteral("Inspect tests")));
  QCOMPARE(window.toolTimelineText(0), QStringLiteral("run_command — success: tests pass"));
}

void MainWindowTest::disablesConflictingControlsWhileRunning() {
  MainWindow window;
  window.setConfigured(true, QStringLiteral("demo-model"));
  window.receiveNotification("agent/status", QJsonObject{{"status", "busy"}});
  QVERIFY(!window.findChild<QPushButton *>(QStringLiteral("chooseWorkspace"))->isEnabled());
  QVERIFY(!window.findChild<QPushButton *>(QStringLiteral("newSession"))->isEnabled());
  QVERIFY(!window.findChild<QListView *>(QStringLiteral("sessionList"))->isEnabled());
  QVERIFY(!window.findChild<QPushButton *>(QStringLiteral("settings"))->isEnabled());
  QVERIFY(!window.runButton()->isEnabled());
  QVERIFY(window.findChild<QPushButton *>(QStringLiteral("cancel"))->isEnabled());
}

void MainWindowTest::displaysRpcErrorsAndRestoresRunState() {
  MainWindow window;
  window.setConfigured(true, QStringLiteral("demo-model"));
  window.receiveNotification("agent/status", QJsonObject{{"status", "busy"}});
  window.receiveError("agent/run", QJsonObject{{"code", -32005}, {"message", "cancelled"}});
  QVERIFY(window.runButton()->isEnabled());
  QVERIFY(window.transcriptText().contains(QStringLiteral("cancelled")));
}

void MainWindowTest::marksInterruptedContentAfterCoreCrash() {
  MainWindow window;
  window.receiveNotification("stream/text", QJsonObject{
    {"runId", "run-1"}, {"eventSeq", 1}, {"messageId", "message-1"},
    {"phase", "execute"}, {"delta", "partial answer"}, {"provisional", true},
  });
  window.coreCrashed(17);
  QVERIFY(window.transcriptText().contains(QStringLiteral("Core interrupted")));
  QVERIFY(window.restartButton()->isEnabled());
}

void MainWindowTest::marksUnexpectedEofRestartable() {
  MainWindow window;
  window.coreStopped(false);
  QVERIFY(window.restartButton()->isEnabled());
  QVERIFY(window.transcriptText().contains(QStringLiteral("Core ended unexpectedly")));
}

QTEST_MAIN(MainWindowTest)
#include "tst_main_window.moc"

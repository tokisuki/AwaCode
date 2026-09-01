#include <QtTest>

#include <QJsonArray>
#include <QListView>
#include <QPlainTextEdit>
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
  void keepsStreamBeforeLaterTranscriptEventsAndClearsCommittedStateForNextRun();
  void marksInterruptedContentAfterCoreCrash();
  void marksUnexpectedEofRestartable();
};

void MainWindowTest::disablesRunUntilConfigured() {
  MainWindow window;
  QVERIFY(!window.runButton()->isEnabled());
  window.setConfigured(true, QStringLiteral("demo-model"));
  QVERIFY(window.runButton()->isEnabled());
}

void MainWindowTest::keepsStreamBeforeLaterTranscriptEventsAndClearsCommittedStateForNextRun() {
  MainWindow window;
  window.receiveNotification("stream/text", QJsonObject{{"messageId", "first"}, {"delta", "first answer"}, {"provisional", true}});
  QTRY_VERIFY_WITH_TIMEOUT(window.transcriptText().contains(QStringLiteral("first answer")), 200);
  window.receiveNotification("agent/phase", QJsonObject{{"phase", "reflect"}});
  QVERIFY(window.transcriptText().indexOf(QStringLiteral("first answer")) < window.transcriptText().indexOf(QStringLiteral("[reflect]")));
  window.receiveNotification("stream/commit", QJsonObject{{"messageId", "first"}});
  QVERIFY(!window.transcriptText().contains(QStringLiteral("[provisional] first answer")));
  QVERIFY(window.transcriptText().indexOf(QStringLiteral("first answer")) < window.transcriptText().indexOf(QStringLiteral("[reflect]")));
  window.setConfigured(true);
  auto *taskInput = window.findChild<QPlainTextEdit *>(QStringLiteral("taskInput"));
  QVERIFY(taskInput != nullptr);
  taskInput->setPlainText(QStringLiteral("second task"));
  window.receiveResponse("session/create", QJsonObject{{"id", "second-session"}});
  QVERIFY(window.transcriptText().indexOf(QStringLiteral("first answer")) < window.transcriptText().indexOf(QStringLiteral("You: second task")));
  window.receiveNotification("stream/text", QJsonObject{{"messageId", "second"}, {"delta", "second answer"}, {"provisional", true}});
  QTRY_VERIFY_WITH_TIMEOUT(window.transcriptText().contains(QStringLiteral("second answer")), 200);
  QCOMPARE(window.transcriptText().count(QStringLiteral("first answer")), 1);
  QVERIFY(window.transcriptText().indexOf(QStringLiteral("first answer")) < window.transcriptText().indexOf(QStringLiteral("second answer")));
  window.receiveError("agent/run", QJsonObject{{"message", "later error"}});
  QVERIFY(window.transcriptText().indexOf(QStringLiteral("second answer")) < window.transcriptText().indexOf(QStringLiteral("later error")));
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

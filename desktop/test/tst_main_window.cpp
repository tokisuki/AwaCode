#include <QtTest>

#include <QJsonArray>
#include <QFrame>
#include <QListView>
#include <QLabel>
#include <QMessageBox>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QTimer>

#include "MainWindow.h"

class MainWindowTest final : public QObject {
  Q_OBJECT

private slots:
  void conversationPaneDominatesAndKeepsComposerDirectlyBelowMessages();
  void userAndAssistantMessagesRenderAsOpposingConversationBubbles();
  void loadsThePackagedAwaBrandLogo();
  void rendersUserAndAssistantBubblesWithDistinctBrandAndNeutralSurfaces();
  void disablesRunUntilConfigured();
  void batchesMultipleProvisionalDeltasOnceAndCommitsThem();
  void hydratesPayloadMessagesAndToolCalls();
  void ignoresBusyWithoutADispatchedRequestId();
  void displaysRpcErrorsAndRestoresRunState();
  void keepsStreamBeforeLaterTranscriptEventsAndClearsCommittedStateForNextRun();
  void marksInterruptedContentAfterCoreCrash();
  void marksUnexpectedEofRestartable();
  void workspaceEpochDropsStaleResponsesAndRequiresCurrentSession();
  void crashKeepsRunDisabledUntilHelloRefreshesTheCurrentWorkspace();
  void manualSessionCreationDoesNotDispatchTheOldPrompt();
  void reloadMarksRejectedCandidates();
  void liveRejectReplacesTheProvisionalMarker();
  void newestSessionLoadWinsWithinOneWorkspaceEpoch();
  void newestSessionListWinsWithinOneWorkspaceEpoch();
  void helloSurvivesWorkspaceSelectionOnTheSameConnection();
  void newestCreateIntentWinsWithinOneWorkspaceEpoch();
  void creatingSessionInvalidatesOlderLoadsAndClearsTheOldProjection();
  void deletingCurrentSessionClearsItsProjectionAndDropsStaleLoads();
  void deletingASelectedUnloadedSessionStillRemovesIt();
  void deleteButtonConfirmsTheSelectedSessionTitle();
};

void MainWindowTest::conversationPaneDominatesAndKeepsComposerDirectlyBelowMessages() {
  MainWindow window;
  window.resize(1280, 800);
  window.show();
  QCoreApplication::processEvents();

  auto *sessionRail = window.findChild<QWidget *>(QStringLiteral("sessionRail"));
  auto *conversationPane = window.findChild<QWidget *>(QStringLiteral("conversationPane"));
  auto *activityRail = window.findChild<QWidget *>(QStringLiteral("activityRail"));
  auto *conversationView = window.findChild<QWidget *>(QStringLiteral("conversationView"));
  auto *taskInput = window.findChild<QPlainTextEdit *>(QStringLiteral("taskInput"));
  QVERIFY(sessionRail != nullptr);
  QVERIFY(conversationPane != nullptr);
  QVERIFY(activityRail != nullptr);
  QVERIFY(conversationView != nullptr);
  QVERIFY(taskInput != nullptr);
  QCOMPARE(conversationView->parentWidget(), conversationPane);
  QCOMPARE(taskInput->parentWidget(), conversationPane);
  QVERIFY(conversationPane->width() > sessionRail->width() * 2);
  QVERIFY(conversationPane->width() > activityRail->width() * 2);
  QVERIFY(taskInput->geometry().top() > conversationView->geometry().bottom());
}

void MainWindowTest::userAndAssistantMessagesRenderAsOpposingConversationBubbles() {
  MainWindow window;
  window.resize(1280, 800);
  window.receiveResponse("session/load", QJsonObject{{"messages", QJsonArray{
    QJsonObject{{"role", "user"}, {"payload", QJsonObject{{"text", "Inspect this project"}}}},
    QJsonObject{{"role", "assistant"}, {"payload", QJsonObject{{"text", "I will inspect it."}}}},
  }}});
  window.show();
  QCoreApplication::processEvents();

  auto *conversationView = window.findChild<QWidget *>(QStringLiteral("conversationView"));
  const auto bubbles = window.findChildren<QFrame *>(QStringLiteral("messageBubble"));
  QCOMPARE(bubbles.size(), 2);
  QFrame *userBubble = nullptr;
  QFrame *assistantBubble = nullptr;
  for (QFrame *bubble : bubbles) {
    if (bubble->property("messageRole") == QStringLiteral("user")) userBubble = bubble;
    if (bubble->property("messageRole") == QStringLiteral("assistant")) assistantBubble = bubble;
  }
  QVERIFY(conversationView != nullptr);
  QVERIFY(userBubble != nullptr);
  QVERIFY(assistantBubble != nullptr);
  const int midpoint = conversationView->mapToGlobal(conversationView->rect().center()).x();
  QVERIFY(userBubble->mapToGlobal(userBubble->rect().center()).x() > midpoint);
  QVERIFY(assistantBubble->mapToGlobal(assistantBubble->rect().center()).x() < midpoint);
}

void MainWindowTest::loadsThePackagedAwaBrandLogo() {
  MainWindow window;
  auto *logo = window.findChild<QLabel *>(QStringLiteral("brandLogo"));
  QVERIFY(logo != nullptr);
  QVERIFY(!logo->pixmap().isNull());
  QCOMPARE(logo->accessibleName(), QStringLiteral("AwaCode logo"));
  QVERIFY(logo->pixmap().width() >= 48);
  QVERIFY(logo->pixmap().height() >= 48);
}

void MainWindowTest::rendersUserAndAssistantBubblesWithDistinctBrandAndNeutralSurfaces() {
  MainWindow window;
  window.resize(1280, 800);
  window.receiveResponse("session/load", QJsonObject{{"messages", QJsonArray{
    QJsonObject{{"role", "user"}, {"payload", QJsonObject{{"text", "User message"}}}},
    QJsonObject{{"role", "assistant"}, {"payload", QJsonObject{{"text", "Assistant message"}}}},
  }}});
  window.show();
  QCoreApplication::processEvents();

  QFrame *userBubble = nullptr;
  QFrame *assistantBubble = nullptr;
  for (QFrame *bubble : window.findChildren<QFrame *>(QStringLiteral("messageBubble"))) {
    if (bubble->property("messageRole") == QStringLiteral("user")) userBubble = bubble;
    if (bubble->property("messageRole") == QStringLiteral("assistant")) assistantBubble = bubble;
  }
  QVERIFY(userBubble != nullptr);
  QVERIFY(assistantBubble != nullptr);
  const QImage userImage = userBubble->grab().toImage();
  const QImage assistantImage = assistantBubble->grab().toImage();
  const QColor userColor = userImage.pixelColor(userImage.width() - 8, userImage.height() / 2);
  const QColor assistantColor = assistantImage.pixelColor(assistantImage.width() - 8, assistantImage.height() / 2);
  QVERIFY(userColor.blue() > userColor.red() + 20);
  QVERIFY(qAbs(assistantColor.red() - assistantColor.green()) < 8);
  QVERIFY(qAbs(assistantColor.green() - assistantColor.blue()) < 8);
  QVERIFY(assistantColor.lightness() > 210);
  QVERIFY(userColor != assistantColor);
}

void MainWindowTest::disablesRunUntilConfigured() {
  MainWindow window;
  QVERIFY(!window.runButton()->isEnabled());
  window.setConfigured(true, QStringLiteral("demo-model"));
  QVERIFY(!window.runButton()->isEnabled());
}

void MainWindowTest::workspaceEpochDropsStaleResponsesAndRequiresCurrentSession() {
  MainWindow window;
  window.setConfigured(true, QStringLiteral("demo-model"));
  const quint64 oldEpoch = window.beginWorkspaceSelection(QStringLiteral("C:/old"));
  const quint64 currentEpoch = window.beginWorkspaceSelection(QStringLiteral("C:/new"));
  window.receiveResponseForEpoch("workspace/set", QJsonObject{{"workspace", "C:/old"}, {"projectId", "old"}}, oldEpoch);
  QVERIFY(!window.runButton()->isEnabled());
  window.receiveResponseForEpoch("workspace/set", QJsonObject{{"workspace", "C:/new"}, {"projectId", "new"}}, currentEpoch);
  window.receiveResponseForEpoch("session/create", QJsonObject{{"id", "current"}, {"title", "New"}, {"status", "idle"}}, currentEpoch);
  QVERIFY(window.runButton()->isEnabled());
}

void MainWindowTest::crashKeepsRunDisabledUntilHelloRefreshesTheCurrentWorkspace() {
  MainWindow window;
  window.setConfigured(true, QStringLiteral("demo-model"));
  const quint64 epoch = window.beginWorkspaceSelection(QStringLiteral("C:/work"));
  window.receiveResponseForEpoch("workspace/set", QJsonObject{{"workspace", "C:/work"}, {"projectId", "p"}}, epoch);
  window.receiveResponseForEpoch("session/create", QJsonObject{{"id", "s"}, {"title", "S"}, {"status", "idle"}}, epoch);
  QVERIFY(window.runButton()->isEnabled());
  window.coreCrashed(17);
  QVERIFY(!window.runButton()->isEnabled());
  window.receiveResponseForEpoch("core/hello", QJsonObject{{"configured", true}, {"model", "demo-model"}}, epoch);
  QVERIFY(!window.runButton()->isEnabled());
}

void MainWindowTest::manualSessionCreationDoesNotDispatchTheOldPrompt() {
  MainWindow window;
  window.setConfigured(true);
  const quint64 epoch = window.beginWorkspaceSelection(QStringLiteral("C:/work"));
  window.receiveResponseForEpoch("workspace/set", QJsonObject{{"workspace", "C:/work"}, {"projectId", "p"}}, epoch);
  auto *taskInput = window.findChild<QPlainTextEdit *>(QStringLiteral("taskInput"));
  taskInput->setPlainText(QStringLiteral("must stay pending"));
  window.receiveResponseForEpoch("session/create", QJsonObject{{"id", "manual"}, {"title", "Manual"}, {"status", "idle"}}, epoch);
  QVERIFY(!window.transcriptText().contains(QStringLiteral("You: must stay pending")));
  QCOMPARE(taskInput->toPlainText(), QStringLiteral("must stay pending"));
}

void MainWindowTest::newestSessionLoadWinsWithinOneWorkspaceEpoch() {
  MainWindow window;
  const quint64 epoch = window.beginWorkspaceSelection(QStringLiteral("C:/work"));
  const quint64 loadA = window.beginRequestGeneration(QStringLiteral("session/load"), QStringLiteral("A"));
  const quint64 loadB = window.beginRequestGeneration(QStringLiteral("session/load"), QStringLiteral("B"));
  window.receiveResponseForGeneration("session/load", QJsonObject{{"messages", QJsonArray{
    QJsonObject{{"role", "assistant"}, {"payload", QJsonObject{{"text", "from B"}}}},
  }}}, epoch, loadB, QStringLiteral("B"));
  window.receiveResponseForGeneration("session/load", QJsonObject{{"messages", QJsonArray{
    QJsonObject{{"role", "assistant"}, {"payload", QJsonObject{{"text", "stale A"}}}},
  }}}, epoch, loadA, QStringLiteral("A"));
  QVERIFY(window.transcriptText().contains(QStringLiteral("from B")));
  QVERIFY(!window.transcriptText().contains(QStringLiteral("stale A")));
}

void MainWindowTest::newestSessionListWinsWithinOneWorkspaceEpoch() {
  MainWindow window;
  const quint64 epoch = window.beginWorkspaceSelection(QStringLiteral("C:/work"));
  const quint64 first = window.beginRequestGeneration(QStringLiteral("session/list"), QStringLiteral("p"));
  const quint64 second = window.beginRequestGeneration(QStringLiteral("session/list"), QStringLiteral("p"));
  window.receiveResponseForGeneration("session/list", QJsonArray{
    QJsonObject{{"id", "new"}, {"title", "Newest"}, {"status", "idle"}},
  }, epoch, second, QStringLiteral("p"));
  window.receiveResponseForGeneration("session/list", QJsonArray{
    QJsonObject{{"id", "old"}, {"title", "Stale"}, {"status", "idle"}},
  }, epoch, first, QStringLiteral("p"));
  auto *view = window.findChild<QListView *>(QStringLiteral("sessionList"));
  QCOMPARE(view->model()->rowCount(), 1);
  QCOMPARE(view->model()->index(0, 0).data().toString(), QStringLiteral("Newest"));
}

void MainWindowTest::helloSurvivesWorkspaceSelectionOnTheSameConnection() {
  MainWindow window;
  window.coreCrashed(19);
  QVERIFY(!window.findChild<QPushButton *>(QStringLiteral("chooseWorkspace"))->isEnabled());
  const quint64 helloGeneration = window.beginRequestGeneration(QStringLiteral("core/hello"));
  const quint64 epoch = window.beginWorkspaceSelection(QStringLiteral("C:/new"));
  window.receiveResponseForGeneration("core/hello",
    QJsonObject{{"configured", true}, {"model", "demo"}}, epoch - 1, helloGeneration);
  QVERIFY(window.findChild<QPushButton *>(QStringLiteral("chooseWorkspace"))->isEnabled());
  QVERIFY(!window.runButton()->isEnabled());
}

void MainWindowTest::newestCreateIntentWinsWithinOneWorkspaceEpoch() {
  MainWindow window;
  window.setConfigured(true);
  const quint64 epoch = window.beginWorkspaceSelection(QStringLiteral("C:/work"));
  auto *taskInput = window.findChild<QPlainTextEdit *>(QStringLiteral("taskInput"));
  taskInput->setPlainText(QStringLiteral("old run prompt"));
  const quint64 runCreate = window.beginRequestGeneration(QStringLiteral("session/create"), QStringLiteral("p"));
  const quint64 manualCreate = window.beginRequestGeneration(QStringLiteral("session/create"), QStringLiteral("p"));
  window.receiveResponseForGeneration("session/create",
    QJsonObject{{"id", "run-session"}, {"title", "Run"}, {"status", "idle"}},
    epoch, runCreate, QStringLiteral("p"), true, QStringLiteral("old run prompt"));
  QCOMPARE(taskInput->toPlainText(), QStringLiteral("old run prompt"));
  QVERIFY(!window.transcriptText().contains(QStringLiteral("You: old run prompt")));
  window.receiveResponseForGeneration("session/create",
    QJsonObject{{"id", "manual"}, {"title", "Manual"}, {"status", "idle"}},
    epoch, manualCreate, QStringLiteral("p"), false);
  QCOMPARE(taskInput->toPlainText(), QStringLiteral("old run prompt"));
  QVERIFY(!window.transcriptText().contains(QStringLiteral("You: old run prompt")));
}

void MainWindowTest::creatingSessionInvalidatesOlderLoadsAndClearsTheOldProjection() {
  MainWindow window;
  const quint64 epoch = window.beginWorkspaceSelection(QStringLiteral("C:/work"));
  const quint64 shownLoad = window.beginRequestGeneration(QStringLiteral("session/load"), QStringLiteral("A"));
  window.receiveResponseForGeneration("session/load", QJsonObject{
    {"messages", QJsonArray{QJsonObject{{"role", "assistant"}, {"payload", QJsonObject{{"text", "session A"}}}}}},
    {"toolCalls", QJsonArray{QJsonObject{{"callId", "a-call"}, {"toolName", "read_file"}, {"status", "success"}}}},
  }, epoch, shownLoad, QStringLiteral("A"));
  QVERIFY(window.transcriptText().contains(QStringLiteral("session A")));
  QVERIFY(!window.toolTimelineText(0).isEmpty());

  const quint64 lateLoad = window.beginRequestGeneration(QStringLiteral("session/load"), QStringLiteral("A"));
  const quint64 createB = window.beginRequestGeneration(QStringLiteral("session/create"), QStringLiteral("p"));
  window.receiveResponseForGeneration("session/create",
    QJsonObject{{"id", "B"}, {"title", "Session B"}, {"status", "idle"}},
    epoch, createB, QStringLiteral("p"), false);
  QVERIFY(window.transcriptText().isEmpty());
  QVERIFY(window.toolTimelineText(0).isEmpty());

  window.receiveResponseForGeneration("session/load", QJsonObject{
    {"messages", QJsonArray{QJsonObject{{"role", "assistant"}, {"payload", QJsonObject{{"text", "late A"}}}}}},
  }, epoch, lateLoad, QStringLiteral("A"));
  QVERIFY(window.transcriptText().isEmpty());
}

void MainWindowTest::deletingCurrentSessionClearsItsProjectionAndDropsStaleLoads() {
  MainWindow window;
  window.setConfigured(true);
  const quint64 epoch = window.beginWorkspaceSelection(QStringLiteral("C:/work"));
  window.receiveResponseForEpoch("workspace/set", QJsonObject{{"workspace", "C:/work"}, {"projectId", "p"}}, epoch);
  window.receiveResponseForEpoch("session/list", QJsonArray{
    QJsonObject{{"id", "A"}, {"title", "Session A"}, {"status", "completed"}},
    QJsonObject{{"id", "B"}, {"title", "Session B"}, {"status", "idle"}},
  }, epoch);
  auto *view = window.findChild<QListView *>(QStringLiteral("sessionList"));
  view->setCurrentIndex(view->model()->index(0, 0));
  const quint64 shownLoad = window.beginRequestGeneration(QStringLiteral("session/load"), QStringLiteral("A"));
  window.receiveResponseForGeneration("session/load", QJsonObject{
    {"messages", QJsonArray{QJsonObject{{"role", "assistant"}, {"payload", QJsonObject{{"text", "session A"}}}}}},
    {"toolCalls", QJsonArray{QJsonObject{{"callId", "a-call"}, {"toolName", "read_file"}, {"status", "success"}}}},
  }, epoch, shownLoad, QStringLiteral("A"));

  const quint64 lateLoad = window.beginRequestGeneration(QStringLiteral("session/load"), QStringLiteral("A"));
  const quint64 deletion = window.beginRequestGeneration(QStringLiteral("session/delete"), QStringLiteral("A"));
  window.receiveResponseForGeneration("session/delete",
    QJsonObject{{"sessionId", "A"}, {"deleted", true}}, epoch, deletion, QStringLiteral("A"));

  QCOMPARE(view->model()->rowCount(), 1);
  QCOMPARE(view->model()->index(0, 0).data().toString(), QStringLiteral("Session B"));
  QVERIFY(window.transcriptText().isEmpty());
  QVERIFY(window.toolTimelineText(0).isEmpty());
  window.receiveResponseForGeneration("session/load", QJsonObject{
    {"messages", QJsonArray{QJsonObject{{"role", "assistant"}, {"payload", QJsonObject{{"text", "stale A"}}}}}},
  }, epoch, lateLoad, QStringLiteral("A"));
  QVERIFY(window.transcriptText().isEmpty());
}

void MainWindowTest::deleteButtonConfirmsTheSelectedSessionTitle() {
  MainWindow window;
  const quint64 epoch = window.beginWorkspaceSelection(QStringLiteral("C:/work"));
  window.receiveResponseForEpoch("workspace/set", QJsonObject{{"workspace", "C:/work"}, {"projectId", "p"}}, epoch);
  window.receiveResponseForEpoch("session/list", QJsonArray{
    QJsonObject{{"id", "A"}, {"title", "Session A"}, {"status", "completed"}},
  }, epoch);
  auto *view = window.findChild<QListView *>(QStringLiteral("sessionList"));
  view->setCurrentIndex(view->model()->index(0, 0));
  auto *deleteButton = window.findChild<QPushButton *>(QStringLiteral("deleteSession"));
  QVERIFY(deleteButton != nullptr);
  QVERIFY(deleteButton->isEnabled());

  QString confirmationText;
  QTimer::singleShot(0, [&confirmationText] {
    for (QWidget *widget : QApplication::topLevelWidgets()) {
      if (auto *box = qobject_cast<QMessageBox *>(widget)) {
        confirmationText = box->text();
        box->done(QMessageBox::Yes);
      }
    }
  });
  QTest::mouseClick(deleteButton, Qt::LeftButton);
  QVERIFY(confirmationText.contains(QStringLiteral("Session A")));
}

void MainWindowTest::deletingASelectedUnloadedSessionStillRemovesIt() {
  MainWindow window;
  const quint64 epoch = window.beginWorkspaceSelection(QStringLiteral("C:/work"));
  window.receiveResponseForEpoch("workspace/set", QJsonObject{{"workspace", "C:/work"}, {"projectId", "p"}}, epoch);
  window.receiveResponseForEpoch("session/list", QJsonArray{
    QJsonObject{{"id", "A"}, {"title", "Session A"}, {"status", "idle"}},
  }, epoch);
  auto *view = window.findChild<QListView *>(QStringLiteral("sessionList"));
  view->setCurrentIndex(view->model()->index(0, 0));

  const quint64 deletion = window.beginRequestGeneration(QStringLiteral("session/delete"), QStringLiteral("A"));
  window.receiveResponseForGeneration("session/delete",
    QJsonObject{{"sessionId", "A"}, {"deleted", true}}, epoch, deletion, QStringLiteral("A"));
  QCOMPARE(view->model()->rowCount(), 0);
}

void MainWindowTest::reloadMarksRejectedCandidates() {
  MainWindow window;
  window.receiveResponse("session/load", QJsonObject{{"messages", QJsonArray{
    QJsonObject{{"role", "assistant"}, {"payload", QJsonObject{{"text", "superseded"}, {"candidateStatus", "rejected"}}}},
    QJsonObject{{"role", "assistant"}, {"payload", QJsonObject{{"text", "final"}, {"candidateStatus", "accepted"}}}},
  }}});
  QVERIFY(window.transcriptText().contains(QStringLiteral("[rejected] superseded")));
  QVERIFY(window.transcriptText().contains(QStringLiteral("final")));
}

void MainWindowTest::liveRejectReplacesTheProvisionalMarker() {
  MainWindow window;
  window.receiveNotification("stream/text", QJsonObject{{"messageId", "candidate"}, {"delta", "superseded"}, {"provisional", true}});
  QTRY_VERIFY_WITH_TIMEOUT(window.transcriptText().contains(QStringLiteral("[provisional] superseded")), 200);
  window.receiveNotification("stream/reject", QJsonObject{{"messageId", "candidate"}});
  QVERIFY(window.transcriptText().contains(QStringLiteral("[rejected] superseded")));
  QVERIFY(!window.transcriptText().contains(QStringLiteral("[provisional] superseded")));
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
  QVERIFY(!window.transcriptText().contains(QStringLiteral("You: second task")));
  window.receiveNotification("stream/text", QJsonObject{{"messageId", "second"}, {"delta", "second answer"}, {"provisional", true}});
  QTRY_VERIFY_WITH_TIMEOUT(window.transcriptText().contains(QStringLiteral("second answer")), 200);
  QCOMPARE(window.transcriptText().count(QStringLiteral("first answer")), 0);
  QVERIFY(window.transcriptText().contains(QStringLiteral("second answer")));
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

void MainWindowTest::ignoresBusyWithoutADispatchedRequestId() {
  MainWindow window;
  window.setConfigured(true, QStringLiteral("demo-model"));
  const quint64 epoch = window.beginWorkspaceSelection(QStringLiteral("C:/work"));
  window.receiveResponseForEpoch("workspace/set", QJsonObject{{"workspace", "C:/work"}, {"projectId", "p"}}, epoch);
  window.receiveNotification("agent/status", QJsonObject{{"status", "busy"}});
  QVERIFY(window.findChild<QPushButton *>(QStringLiteral("chooseWorkspace"))->isEnabled());
  QVERIFY(window.runButton()->isEnabled());
  QVERIFY(!window.findChild<QPushButton *>(QStringLiteral("cancel"))->isEnabled());
}

void MainWindowTest::displaysRpcErrorsAndRestoresRunState() {
  MainWindow window;
  window.setConfigured(true, QStringLiteral("demo-model"));
  const quint64 epoch = window.beginWorkspaceSelection(QStringLiteral("C:/work"));
  window.receiveResponseForEpoch("workspace/set", QJsonObject{{"workspace", "C:/work"}, {"projectId", "p"}}, epoch);
  window.receiveNotification("agent/status", QJsonObject{{"status", "busy"}});
  window.receiveError("agent/run", QJsonObject{
    {"code", -32008},
    {"message", "Model request failed"},
    {"data", QJsonObject{{"detail", "reasoning_content must be passed back"}}},
  });
  QVERIFY(window.runButton()->isEnabled());
  QVERIFY(window.transcriptText().contains(QStringLiteral("Model request failed")));
  QVERIFY(window.transcriptText().contains(QStringLiteral("reasoning_content must be passed back")));
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

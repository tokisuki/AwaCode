#include <QtTest>

#include "AgentProcessManager.h"

class AgentProcessManagerTest final : public QObject {
  Q_OBJECT

private slots:
  void startsHandlesReverseApprovalAndCleanEof();
  void preservesArrayRpcResults();
  void reportsCrash();
};

void AgentProcessManagerTest::startsHandlesReverseApprovalAndCleanEof() {
  AgentProcessManager manager(QString::fromUtf8(AWACODE_FAKE_CORE_PATH));
  QSignalSpy started(&manager, &AgentProcessManager::started);
  QSignalSpy approval(&manager, &AgentProcessManager::approvalRequested);
  QSignalSpy response(&manager, &AgentProcessManager::responseReceived);
  QSignalSpy stopped(&manager, &AgentProcessManager::stopped);

  manager.start();
  QTRY_VERIFY_WITH_TIMEOUT(!started.isEmpty(), 2'000);
  const QString requestId = manager.request("core/hello", QJsonObject{});
  QVERIFY(approval.wait(2'000));
  QCOMPARE(approval.constFirst().at(0).toString(), QStringLiteral("core-1"));
  manager.replyToApproval("core-1", "allow_once");
  QTRY_VERIFY_WITH_TIMEOUT(!response.isEmpty(), 2'000);
  QCOMPARE(response.constFirst().at(0).toString(), requestId);
  QCOMPARE(response.constFirst().at(1).toJsonValue().toObject().value("configured").toBool(), false);
  manager.closeInput();
  QVERIFY(stopped.wait(2'000));
  QCOMPARE(stopped.constFirst().at(0).toBool(), true);
}

void AgentProcessManagerTest::preservesArrayRpcResults() {
  AgentProcessManager manager(QString::fromUtf8(AWACODE_FAKE_CORE_PATH));
  QSignalSpy started(&manager, &AgentProcessManager::started);
  QSignalSpy response(&manager, &AgentProcessManager::responseReceived);
  QSignalSpy stopped(&manager, &AgentProcessManager::stopped);
  manager.start();
  QTRY_VERIFY_WITH_TIMEOUT(!started.isEmpty(), 2'000);
  const QString requestId = manager.request("session/list", QJsonObject{{"projectId", "project-1"}});
  QTRY_VERIFY_WITH_TIMEOUT(!response.isEmpty(), 2'000);
  QCOMPARE(response.constFirst().at(0).toString(), requestId);
  QVERIFY(response.constFirst().at(1).toJsonValue().isArray());
  QCOMPARE(response.constFirst().at(1).toJsonValue().toArray().at(0).toObject().value("id").toString(), QStringLiteral("session-1"));
  manager.closeInput();
  QVERIFY(stopped.wait(2'000));
}

void AgentProcessManagerTest::reportsCrash() {
  AgentProcessManager manager(QString::fromUtf8(AWACODE_FAKE_CORE_PATH), {"--crash"});
  QSignalSpy crashed(&manager, &AgentProcessManager::crashed);
  manager.start();
  QVERIFY(crashed.wait(2'000));
  QCOMPARE(crashed.constFirst().at(0).toInt(), 17);
}

QTEST_MAIN(AgentProcessManagerTest)
#include "tst_agent_process_manager.moc"

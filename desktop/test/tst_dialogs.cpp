#include <QtTest>

#include <QLineEdit>

#include "ApprovalDialog.h"
#include "SettingsDialog.h"

class DialogsTest final : public QObject {
  Q_OBJECT

private slots:
  void settingsUseCoreCredentialDto();
  void approvalDefaultsToDeny();
};

void DialogsTest::settingsUseCoreCredentialDto() {
  SettingsDialog dialog;
  auto *baseUrl = dialog.findChild<QLineEdit *>(QStringLiteral("baseUrl"));
  auto *model = dialog.findChild<QLineEdit *>(QStringLiteral("model"));
  auto *apiKey = dialog.findChild<QLineEdit *>(QStringLiteral("apiKey"));
  QVERIFY(baseUrl != nullptr);
  QVERIFY(model != nullptr);
  QVERIFY(apiKey != nullptr);
  baseUrl->setText(QStringLiteral("https://example.invalid/v1"));
  model->setText(QStringLiteral("demo-model"));
  apiKey->setText(QStringLiteral("not-a-real-key"));
  const QJsonObject settings = dialog.settings();
  QCOMPARE(settings.value("contextLimit").toInt(), 32768);
  QCOMPARE(settings.value("maxOutputTokens").toInt(), 4096);
  QCOMPARE(settings.value("credential").toObject().value("action").toString(), QStringLiteral("store"));
  QCOMPARE(settings.value("credential").toObject().value("apiKey").toString(), QStringLiteral("not-a-real-key"));
  QVERIFY(!settings.contains("apiKey"));
  QVERIFY(!settings.contains("limits"));
}

void DialogsTest::approvalDefaultsToDeny() {
  ApprovalDialog dialog(QJsonObject{{"title", "Run test"}, {"preview", QJsonObject{}}});
  QCOMPARE(dialog.decision(), QStringLiteral("deny"));
}

QTEST_MAIN(DialogsTest)
#include "tst_dialogs.moc"

#include <QtTest>

#include <QLineEdit>
#include <QDialogButtonBox>
#include <QPushButton>

#include "ApprovalDialog.h"
#include "SettingsDialog.h"

class DialogsTest final : public QObject {
  Q_OBJECT

private slots:
  void settingsUseCoreCredentialDto();
  void statusPrefillsNonSecretSettingsAndPreservesCredential();
  void saveRemainsOpenUntilResponseIsPresented();
  void canExplicitlyRemoveAStoredCredential();
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

void DialogsTest::saveRemainsOpenUntilResponseIsPresented() {
  SettingsDialog dialog;
  dialog.show();
  auto *buttons = dialog.findChild<QDialogButtonBox *>();
  auto *save = buttons->button(QDialogButtonBox::Save);
  QSignalSpy requested(&dialog, &SettingsDialog::saveRequested);
  QTest::mouseClick(save, Qt::LeftButton);
  QCOMPARE(requested.count(), 1);
  QVERIFY(dialog.isVisible());
  QVERIFY(!save->isEnabled());
  dialog.showSaveResult(QStringLiteral("Configuration saved"));
  QVERIFY(dialog.isVisible());
  QVERIFY(save->isEnabled());
  QCOMPARE(dialog.statusText(), QStringLiteral("Configuration saved"));
}

void DialogsTest::statusPrefillsNonSecretSettingsAndPreservesCredential() {
  SettingsDialog dialog;
  dialog.applyStatus(QJsonObject{
    {"runnable", true}, {"baseUrl", "https://example.invalid/v1"}, {"model", "fixture-model"},
    {"contextLimit", 4096}, {"maxOutputTokens", 1024}, {"hasApiKey", true},
  });
  QCOMPARE(dialog.findChild<QLineEdit *>(QStringLiteral("baseUrl"))->text(), QStringLiteral("https://example.invalid/v1"));
  QCOMPARE(dialog.findChild<QLineEdit *>(QStringLiteral("model"))->text(), QStringLiteral("fixture-model"));
  QCOMPARE(dialog.findChild<QLineEdit *>(QStringLiteral("apiKey"))->text(), QString());
  QCOMPARE(dialog.settings().value("credential").toObject().value("action").toString(), QStringLiteral("keep"));
}

void DialogsTest::canExplicitlyRemoveAStoredCredential() {
  SettingsDialog dialog;
  dialog.applyStatus(QJsonObject{{"hasApiKey", true}});
  auto *remove = dialog.findChild<QPushButton *>(QStringLiteral("removeApiKey"));
  QVERIFY(remove != nullptr);
  QTest::mouseClick(remove, Qt::LeftButton);
  QCOMPARE(dialog.settings().value("credential").toObject().value("action").toString(), QStringLiteral("remove"));
}

void DialogsTest::approvalDefaultsToDeny() {
  ApprovalDialog dialog(QJsonObject{{"title", "Run test"}, {"preview", QJsonObject{}}});
  QCOMPARE(dialog.decision(), QStringLiteral("deny"));
}

QTEST_MAIN(DialogsTest)
#include "tst_dialogs.moc"

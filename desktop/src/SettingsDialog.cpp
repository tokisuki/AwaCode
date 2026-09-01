#include "SettingsDialog.h"

#include <QDialogButtonBox>
#include <QFormLayout>
#include <QLabel>
#include <QLineEdit>
#include <QPushButton>

SettingsDialog::SettingsDialog(QWidget *parent) : QDialog(parent) {
  setWindowTitle(QStringLiteral("Model settings"));
  auto *layout = new QFormLayout(this);
  baseUrl_ = new QLineEdit(this);
  model_ = new QLineEdit(this);
  contextLimit_ = new QLineEdit(QStringLiteral("32768"), this);
  maxOutput_ = new QLineEdit(QStringLiteral("4096"), this);
  apiKey_ = new QLineEdit(this);
  baseUrl_->setObjectName(QStringLiteral("baseUrl"));
  model_->setObjectName(QStringLiteral("model"));
  contextLimit_->setObjectName(QStringLiteral("contextLimit"));
  maxOutput_->setObjectName(QStringLiteral("maxOutputTokens"));
  apiKey_->setObjectName(QStringLiteral("apiKey"));
  apiKey_->setEchoMode(QLineEdit::Password);
  status_ = new QLabel(this);
  layout->addRow(QStringLiteral("Base URL"), baseUrl_);
  layout->addRow(QStringLiteral("Model"), model_);
  layout->addRow(QStringLiteral("Context limit"), contextLimit_);
  layout->addRow(QStringLiteral("Max output"), maxOutput_);
  layout->addRow(QStringLiteral("API key"), apiKey_);
  removeApiKey_ = new QPushButton(QStringLiteral("Remove saved key"), this);
  removeApiKey_->setObjectName(QStringLiteral("removeApiKey"));
  removeApiKey_->setEnabled(false);
  connect(removeApiKey_, &QPushButton::clicked, this, [this] {
    removeCredential_ = true;
    apiKey_->clear();
    apiKey_->setPlaceholderText(QStringLiteral("Stored key will be removed"));
  });
  connect(apiKey_, &QLineEdit::textEdited, this, [this](const QString &text) {
    if (!text.isEmpty()) removeCredential_ = false;
  });
  layout->addRow(QString(), removeApiKey_);
  layout->addRow(status_);
  buttons_ = new QDialogButtonBox(QDialogButtonBox::Save | QDialogButtonBox::Cancel, this);
  testButton_ = buttons_->addButton(QStringLiteral("Test connection"), QDialogButtonBox::ActionRole);
  connect(testButton_, &QPushButton::clicked, this, &SettingsDialog::testRequested);
  connect(buttons_, &QDialogButtonBox::accepted, this, [this] {
    buttons_->setEnabled(false);
    emit saveRequested(settings());
  });
  connect(buttons_, &QDialogButtonBox::rejected, this, &QDialog::reject);
  layout->addRow(buttons_);
}

void SettingsDialog::setStatusText(const QString &text) { status_->setText(text); }
QString SettingsDialog::statusText() const { return status_->text(); }

void SettingsDialog::showSaveResult(const QString &text) {
  buttons_->setEnabled(true);
  setStatusText(text);
}

void SettingsDialog::applyStatus(const QJsonObject &status) {
  baseUrl_->setText(status.value("baseUrl").toString());
  model_->setText(status.value("model").toString());
  contextLimit_->setText(QString::number(status.value("contextLimit").toInt(32768)));
  maxOutput_->setText(QString::number(status.value("maxOutputTokens").toInt(4096)));
  const bool hasApiKey = status.value("hasApiKey").toBool();
  removeCredential_ = false;
  removeApiKey_->setEnabled(hasApiKey);
  apiKey_->clear();
  apiKey_->setPlaceholderText(hasApiKey ? QStringLiteral("Stored key preserved") : QString());
  setStatusText(status.value("runnable").toBool() ? QStringLiteral("Configuration is ready") : QStringLiteral("Configuration is incomplete"));
}

QJsonObject SettingsDialog::settings() const {
  const QString action = removeCredential_ ? QStringLiteral("remove")
    : apiKey_->text().isEmpty() ? QStringLiteral("keep") : QStringLiteral("store");
  QJsonObject credential{{"action", action}};
  if (action == QStringLiteral("store")) credential.insert("apiKey", apiKey_->text());
  QJsonObject result{
    {"baseUrl", baseUrl_->text()},
    {"model", model_->text()},
    {"contextLimit", contextLimit_->text().toInt()},
    {"maxOutputTokens", maxOutput_->text().toInt()},
    {"credential", credential},
  };
  return result;
}

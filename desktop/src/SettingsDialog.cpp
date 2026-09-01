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
  layout->addRow(status_);
  auto *buttons = new QDialogButtonBox(QDialogButtonBox::Save | QDialogButtonBox::Cancel, this);
  auto *test = buttons->addButton(QStringLiteral("Test connection"), QDialogButtonBox::ActionRole);
  connect(test, &QPushButton::clicked, this, &SettingsDialog::testRequested);
  connect(buttons, &QDialogButtonBox::accepted, this, [this] { emit saveRequested(settings()); accept(); });
  connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
  layout->addRow(buttons);
}

void SettingsDialog::setStatusText(const QString &text) { status_->setText(text); }

QJsonObject SettingsDialog::settings() const {
  QJsonObject credential{{"action", apiKey_->text().isEmpty() ? "keep" : "store"}};
  if (!apiKey_->text().isEmpty()) credential.insert("apiKey", apiKey_->text());
  QJsonObject result{
    {"baseUrl", baseUrl_->text()},
    {"model", model_->text()},
    {"contextLimit", contextLimit_->text().toInt()},
    {"maxOutputTokens", maxOutput_->text().toInt()},
    {"credential", credential},
  };
  return result;
}

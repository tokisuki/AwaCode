#pragma once

#include <QDialog>
#include <QJsonObject>

class QLineEdit;
class QLabel;
class QDialogButtonBox;
class QPushButton;

class SettingsDialog final : public QDialog {
  Q_OBJECT

public:
  explicit SettingsDialog(QWidget *parent = nullptr);
  void setStatusText(const QString &text);
  QString statusText() const;
  void showSaveResult(const QString &text);
  void applyStatus(const QJsonObject &status);
  QJsonObject settings() const;

signals:
  void saveRequested(const QJsonObject &settings);
  void testRequested();

private:
  QLineEdit *baseUrl_;
  QLineEdit *model_;
  QLineEdit *contextLimit_;
  QLineEdit *maxOutput_;
  QLineEdit *apiKey_;
  QLabel *status_;
  QDialogButtonBox *buttons_ = nullptr;
  QPushButton *testButton_ = nullptr;
};

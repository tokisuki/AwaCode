#pragma once

#include <QDialog>
#include <QJsonObject>

class ApprovalDialog final : public QDialog {
  Q_OBJECT

public:
  explicit ApprovalDialog(const QJsonObject &request, QWidget *parent = nullptr);
  QString decision() const;

private:
  QString decision_ = QStringLiteral("deny");
};

#include "ApprovalDialog.h"

#include <QDialogButtonBox>
#include <QJsonDocument>
#include <QLabel>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QVBoxLayout>

ApprovalDialog::ApprovalDialog(const QJsonObject &request, QWidget *parent) : QDialog(parent) {
  setWindowTitle(QStringLiteral("Approve local action"));
  auto *layout = new QVBoxLayout(this);
  layout->addWidget(new QLabel(request.value("title").toString(), this));
  layout->addWidget(new QLabel(QStringLiteral("Workspace: %1").arg(request.value("workspace").toString()), this));
  auto *preview = new QPlainTextEdit(this);
  preview->setReadOnly(true);
  preview->setPlainText(QString::fromUtf8(QJsonDocument(request.value("preview").toObject()).toJson(QJsonDocument::Indented)));
  layout->addWidget(preview);
  auto *buttons = new QDialogButtonBox(QDialogButtonBox::Cancel, this);
  auto *allow = buttons->addButton(QStringLiteral("Allow once"), QDialogButtonBox::AcceptRole);
  connect(allow, &QPushButton::clicked, this, [this] { decision_ = QStringLiteral("allow_once"); accept(); });
  connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
  layout->addWidget(buttons);
}

QString ApprovalDialog::decision() const { return decision_; }

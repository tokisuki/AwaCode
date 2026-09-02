#include "ApprovalDialog.h"

#include <QDialogButtonBox>
#include <QFontDatabase>
#include <QFrame>
#include <QGridLayout>
#include <QLabel>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QVBoxLayout>

ApprovalDialog::ApprovalDialog(const QJsonObject &request, QWidget *parent) : QDialog(parent) {
  setObjectName(QStringLiteral("approvalDialog"));
  setWindowTitle(QStringLiteral("Approve local action"));
  setMinimumWidth(600);
  auto *layout = new QVBoxLayout(this);
  layout->setContentsMargins(24, 22, 24, 20);
  layout->setSpacing(14);

  auto *title = new QLabel(request.value("title").toString(QStringLiteral("Run shell command")), this);
  title->setObjectName(QStringLiteral("approvalTitle"));
  layout->addWidget(title);
  auto *description = new QLabel(
    QStringLiteral("Check the exact command before allowing it to run on this computer."), this);
  description->setObjectName(QStringLiteral("approvalDescription"));
  description->setWordWrap(true);
  layout->addWidget(description);

  const QJsonObject preview = request.value("preview").toObject();
  const QJsonValue commandValue = preview.value("command");
  const QString commandText = commandValue.isString() ? commandValue.toString() : QString();
  const bool validCommand = request.value("kind").toString() == QStringLiteral("command")
    && !commandText.trimmed().isEmpty();

  auto *commandLabel = new QLabel(QStringLiteral("Command"), this);
  commandLabel->setObjectName(QStringLiteral("approvalSectionLabel"));
  layout->addWidget(commandLabel);
  auto *command = new QPlainTextEdit(this);
  command->setObjectName(QStringLiteral("approvalCommand"));
  command->setReadOnly(true);
  command->setLineWrapMode(QPlainTextEdit::WidgetWidth);
  command->setFont(QFontDatabase::systemFont(QFontDatabase::FixedFont));
  command->setMinimumHeight(88);
  command->setMaximumHeight(150);
  command->setPlainText(validCommand ? commandText : QStringLiteral("Command details are unavailable."));
  layout->addWidget(command);

  auto *details = new QFrame(this);
  details->setObjectName(QStringLiteral("approvalDetails"));
  auto *detailsLayout = new QGridLayout(details);
  detailsLayout->setContentsMargins(12, 10, 12, 10);
  detailsLayout->setHorizontalSpacing(16);
  detailsLayout->setVerticalSpacing(7);
  detailsLayout->addWidget(new QLabel(QStringLiteral("Working directory"), details), 0, 0);
  auto *cwd = new QLabel(preview.value("cwd").toString(QStringLiteral("Unavailable")), details);
  cwd->setObjectName(QStringLiteral("approvalCwd"));
  cwd->setTextInteractionFlags(Qt::TextSelectableByMouse);
  detailsLayout->addWidget(cwd, 0, 1);
  detailsLayout->addWidget(new QLabel(QStringLiteral("Timeout"), details), 1, 0);
  QString timeoutText = QStringLiteral("Unavailable");
  const QJsonValue timeoutValue = preview.value("timeoutMs");
  if (timeoutValue.isDouble() && timeoutValue.toDouble() > 0) {
    const qint64 timeoutMs = static_cast<qint64>(timeoutValue.toDouble());
    timeoutText = timeoutMs % 1000 == 0
      ? QStringLiteral("%1 seconds").arg(timeoutMs / 1000)
      : QStringLiteral("%1 ms").arg(timeoutMs);
  }
  auto *timeout = new QLabel(timeoutText, details);
  timeout->setObjectName(QStringLiteral("approvalTimeout"));
  detailsLayout->addWidget(timeout, 1, 1);
  detailsLayout->setColumnStretch(1, 1);
  layout->addWidget(details);

  auto *warning = new QLabel(preview.value("warning").toString(
    QStringLiteral("This action could not be verified. Deny it and try again.")), this);
  warning->setObjectName(QStringLiteral("approvalWarning"));
  warning->setWordWrap(true);
  layout->addWidget(warning);

  auto *buttons = new QDialogButtonBox(QDialogButtonBox::Cancel, this);
  buttons->button(QDialogButtonBox::Cancel)->setText(QStringLiteral("Deny"));
  auto *allow = buttons->addButton(QStringLiteral("Allow once"), QDialogButtonBox::AcceptRole);
  allow->setObjectName(QStringLiteral("approvalAllow"));
  allow->setEnabled(validCommand);
  connect(allow, &QPushButton::clicked, this, [this] { decision_ = QStringLiteral("allow_once"); accept(); });
  connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
  layout->addWidget(buttons);
}

QString ApprovalDialog::decision() const { return decision_; }

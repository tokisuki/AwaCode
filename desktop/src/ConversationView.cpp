#include "ConversationView.h"

#include <QFrame>
#include <QHBoxLayout>
#include <QLabel>
#include <QResizeEvent>
#include <QScrollBar>
#include <QTimer>
#include <QVBoxLayout>

ConversationView::ConversationView(QWidget *parent) : QScrollArea(parent) {
  setObjectName(QStringLiteral("conversationView"));
  setWidgetResizable(true);
  setFrameShape(QFrame::NoFrame);
  setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
  content_ = new QWidget(this);
  content_->setObjectName(QStringLiteral("conversationContent"));
  messages_ = new QVBoxLayout(content_);
  messages_->setContentsMargins(12, 16, 12, 16);
  messages_->setSpacing(8);
  messages_->addStretch();
  setWidget(content_);
}

void ConversationView::setMessages(const QList<ConversationMessage> &messages) {
  const int previousMaximum = verticalScrollBar()->maximum();
  const int previousValue = verticalScrollBar()->value();
  const bool followLatest = previousMaximum == 0 || previousValue >= previousMaximum - 4;
  while (QLayoutItem *item = messages_->takeAt(0)) {
    delete item->widget();
    delete item;
  }

  plainText_.clear();
  for (const ConversationMessage &message : messages) {
    const QString marker = message.rejected ? QStringLiteral("[rejected] ")
      : message.provisional ? QStringLiteral("[provisional] ") : QString();
    if (message.role == QStringLiteral("user"))
      plainText_ += QStringLiteral("You: %1%2\n").arg(marker, message.text);
    else if (message.role == QStringLiteral("assistant"))
      plainText_ += QStringLiteral("%1%2\n").arg(marker, message.text);
    else
      plainText_ += marker + message.text;
    if (message.text.trimmed().isEmpty()) continue;
    auto *row = new QWidget(content_);
    row->setObjectName(QStringLiteral("messageRow"));
    auto *rowLayout = new QHBoxLayout(row);
    rowLayout->setContentsMargins(0, 2, 0, 2);
    rowLayout->setSpacing(0);

    auto *bubble = new QFrame(row);
    bubble->setObjectName(QStringLiteral("messageBubble"));
    bubble->setProperty("messageRole", message.role);
    bubble->setSizePolicy(QSizePolicy::Fixed, QSizePolicy::Preferred);
    auto *bubbleLayout = new QVBoxLayout(bubble);
    bubbleLayout->setContentsMargins(14, 10, 14, 11);
    bubbleLayout->setSpacing(5);

    if (message.role != QStringLiteral("system")) {
      auto *role = new QLabel(message.role == QStringLiteral("user")
        ? QStringLiteral("YOU") : QStringLiteral("AWACODE"), bubble);
      role->setObjectName(QStringLiteral("messageRoleLabel"));
      role->setProperty("messageRole", message.role);
      bubbleLayout->addWidget(role);
    }
    if (message.rejected || message.provisional) {
      auto *state = new QLabel(message.rejected
        ? QStringLiteral("Superseded") : QStringLiteral("Working"), bubble);
      state->setObjectName(QStringLiteral("messageStateLabel"));
      bubbleLayout->addWidget(state);
    }
    auto *text = new QLabel(message.text.trimmed(), bubble);
    text->setObjectName(QStringLiteral("messageText"));
    text->setTextFormat(Qt::PlainText);
    text->setTextInteractionFlags(Qt::TextSelectableByMouse);
    text->setWordWrap(true);
    text->setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Preferred);
    bubbleLayout->addWidget(text);

    if (message.role == QStringLiteral("user")) {
      rowLayout->addStretch(1);
      rowLayout->addWidget(bubble);
    } else if (message.role == QStringLiteral("assistant")) {
      rowLayout->addWidget(bubble);
      rowLayout->addStretch(1);
    } else {
      rowLayout->addStretch(1);
      rowLayout->addWidget(bubble);
      rowLayout->addStretch(1);
    }
    messages_->addWidget(row);
  }
  messages_->addStretch(1);
  updateBubbleWidths();
  QTimer::singleShot(0, this, [this, followLatest, previousValue] {
    messages_->activate();
    content_->adjustSize();
    const int target = followLatest
      ? verticalScrollBar()->maximum()
      : qMin(previousValue, verticalScrollBar()->maximum());
    verticalScrollBar()->setValue(target);
  });
}

QString ConversationView::plainText() const { return plainText_; }

void ConversationView::resizeEvent(QResizeEvent *event) {
  QScrollArea::resizeEvent(event);
  updateBubbleWidths();
}

void ConversationView::updateBubbleWidths() {
  const int availableWidth = qMax(240, viewport()->width() - 24);
  const int bubbleWidth = qMin(680, availableWidth * 7 / 8);
  for (QFrame *bubble : content_->findChildren<QFrame *>(QStringLiteral("messageBubble"))) {
    bubble->setFixedWidth(bubbleWidth);
    if (auto *text = bubble->findChild<QLabel *>(QStringLiteral("messageText"))) {
      const int textWidth = qMax(1, bubbleWidth - 28);
      text->setFixedWidth(textWidth);
      const bool needsWrapping = text->text().contains(QLatin1Char('\n'))
        || text->fontMetrics().horizontalAdvance(text->text()) > textWidth;
      text->setWordWrap(needsWrapping);
      const int textHeight = needsWrapping
        ? text->heightForWidth(textWidth)
        : text->fontMetrics().lineSpacing();
      text->setFixedHeight(qMax(text->fontMetrics().lineSpacing(), textHeight));
    }
  }
}

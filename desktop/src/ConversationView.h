#pragma once

#include <QList>
#include <QScrollArea>
#include <QString>

class QVBoxLayout;
class QWidget;

struct ConversationMessage {
  QString role;
  QString text;
  bool provisional = false;
  bool rejected = false;
};

class ConversationView final : public QScrollArea {
public:
  explicit ConversationView(QWidget *parent = nullptr);
  void setMessages(const QList<ConversationMessage> &messages);
  QString plainText() const;

private:
  QWidget *content_ = nullptr;
  QVBoxLayout *messages_ = nullptr;
  QString plainText_;
};

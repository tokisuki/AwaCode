#pragma once

#include <QAbstractListModel>

struct SessionSummary {
  QString id;
  QString title;
  QString status;
};

class SessionListModel final : public QAbstractListModel {
  Q_OBJECT

public:
  enum Role { SessionIdRole = Qt::UserRole + 1, StatusRole };

  explicit SessionListModel(QObject *parent = nullptr);
  int rowCount(const QModelIndex &parent = {}) const override;
  QVariant data(const QModelIndex &index, int role) const override;
  void setSessions(QList<SessionSummary> sessions);
  void prepend(SessionSummary session);
  bool removeById(const QString &sessionId);
  SessionSummary at(int row) const;

private:
  QList<SessionSummary> sessions_;
};

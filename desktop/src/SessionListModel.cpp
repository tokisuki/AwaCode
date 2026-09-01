#include "SessionListModel.h"

SessionListModel::SessionListModel(QObject *parent) : QAbstractListModel(parent) {}

int SessionListModel::rowCount(const QModelIndex &parent) const {
  return parent.isValid() ? 0 : sessions_.size();
}

QVariant SessionListModel::data(const QModelIndex &index, int role) const {
  if (!index.isValid() || index.row() < 0 || index.row() >= sessions_.size()) return {};
  const SessionSummary &session = sessions_.at(index.row());
  if (role == Qt::DisplayRole) {
    return session.status == QStringLiteral("idle")
      ? session.title : QStringLiteral("%1 [%2]").arg(session.title, session.status);
  }
  if (role == SessionIdRole) return session.id;
  if (role == StatusRole) return session.status;
  return {};
}

void SessionListModel::setSessions(QList<SessionSummary> sessions) {
  beginResetModel();
  sessions_ = std::move(sessions);
  endResetModel();
}

void SessionListModel::prepend(SessionSummary session) {
  beginInsertRows({}, 0, 0);
  sessions_.prepend(std::move(session));
  endInsertRows();
}

bool SessionListModel::removeById(const QString &sessionId) {
  for (int row = 0; row < sessions_.size(); ++row) {
    if (sessions_.at(row).id != sessionId) continue;
    beginRemoveRows({}, row, row);
    sessions_.removeAt(row);
    endRemoveRows();
    return true;
  }
  return false;
}

SessionSummary SessionListModel::at(int row) const { return sessions_.value(row); }

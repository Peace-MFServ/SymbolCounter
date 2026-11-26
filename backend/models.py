"""
What the reader keeps: the team's logins, the jobs, the doors confirmed on each
job, and the invites that let an architect send plans in.

The database on the server still holds the tables of the old door schedule and
device counting tools (sets, products, drawings). Nothing here reads them; they
are left where they are, untouched.
"""
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from database import Base


class User(Base):
    __tablename__ = "users"
    id               = Column(Integer, primary_key=True, index=True)
    email            = Column(String, unique=True, index=True, nullable=False)
    name             = Column(String, nullable=False)
    hashed_password  = Column(String, nullable=False)
    is_active        = Column(Boolean, default=True)
    created_at       = Column(DateTime(timezone=True), server_default=func.now())
    projects         = relationship("Project", back_populates="owner")


class Project(Base):
    """A job: the floor plans of one project, read for its doors."""
    __tablename__ = "projects"
    id            = Column(Integer, primary_key=True, index=True)
    name          = Column(String, nullable=False)
    client        = Column(String, default="")
    site          = Column(String, default="")
    description   = Column(Text, default="")
    drawing_firm  = Column(String, default="")
    quote_no      = Column(String, default="")
    rep           = Column(String, default="")
    kind          = Column(String, default="doors")     # old device counting jobs say "symbols" and are not shown
    notes         = Column(Text, default="")
    # sent in by an architect through the portal
    source        = Column(String, default="")          # "" made here | "portal"
    stage         = Column(String, default="")          # portal jobs: new | taken | checked
    brief         = Column(Text, default="")            # the architect's own words about the project
    contact       = Column(Text, default="")            # JSON: company, name, email, phone
    received_at   = Column(DateTime(timezone=True), nullable=True)
    due_at        = Column(DateTime(timezone=True), nullable=True)
    checked_at    = Column(DateTime(timezone=True), nullable=True)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())
    updated_at    = Column(DateTime(timezone=True), onupdate=func.now())
    owner_id      = Column(Integer, ForeignKey("users.id"))
    owner         = relationship("User", back_populates="projects")


class Door(Base):
    """A door confirmed on a job: read off the plans, from a door list, or added by hand.
    (The table has more columns from the old schedule tool; they are not used.)"""
    __tablename__ = "doors"
    id            = Column(Integer, primary_key=True, index=True)
    project_id    = Column(Integer, ForeignKey("projects.id"), nullable=False, index=True)
    ref           = Column(String, default="")
    floor         = Column(String, default="")
    source        = Column(String, default="plan")          # plans | schedule
    note          = Column(String, default="")


class Invite(Base):
    """A link and PIN given to an architect so they can send one project's plans in."""
    __tablename__ = "invites"
    id            = Column(Integer, primary_key=True, index=True)
    token         = Column(String, unique=True, index=True, nullable=False)   # in the link, after the #
    pin_hash      = Column(String, nullable=False)
    firm          = Column(String, default="")
    email         = Column(String, default="")
    project_hint  = Column(String, default="")
    created_by_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())
    expires_at    = Column(DateTime(timezone=True), nullable=False)
    status        = Column(String, default="open")       # open | sent | closed
    failed        = Column(Integer, default=0)           # wrong PINs in a row
    locked        = Column(Boolean, default=False)
    session_ver   = Column(Integer, default=1)           # goes up to end every open session on it
    project_id    = Column(Integer, ForeignKey("projects.id"), nullable=True)
    sent_at       = Column(DateTime(timezone=True), nullable=True)
    created_by    = relationship("User")
